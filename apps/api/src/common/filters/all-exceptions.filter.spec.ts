import {
  type ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisUnavailableError } from '../../infrastructure/redis/redis.service.js';
import { disabledErrorTracker, setErrorTracker } from '../../observability/error-tracker.js';
import { Prisma } from '../../prisma/generated/client.js';
import { ExternalServiceError } from '../http/external-http.js';
import {
  AllExceptionsFilter,
  classifyFailure,
  normalizeException,
} from './all-exceptions.filter.js';

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('database said no', { code, clientVersion: 'spec' });

function hostFor(req: object) {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  const host = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

describe('normalizeException', () => {
  it('keeps the status and message of an HttpException', () => {
    expect(normalizeException(new ConflictException('Email taken'))).toEqual({
      status: 409,
      message: 'Email taken',
    });
    expect(normalizeException(new HttpException('Teapot', 418))).toEqual({
      status: 418,
      message: 'Teapot',
    });
  });

  it('joins a list of validation messages', () => {
    expect(normalizeException(new BadRequestException(['a: required', 'b: too long']))).toEqual({
      status: 400,
      message: 'a: required, b: too long',
    });
  });

  it('maps known database errors to client errors without naming columns', () => {
    expect(normalizeException(prismaError('P2002'))).toEqual({
      status: 409,
      message: 'A record with this value already exists',
    });
    expect(normalizeException(prismaError('P2003')).status).toBe(409);
    expect(normalizeException(prismaError('P2025')).status).toBe(404);
    expect(normalizeException(prismaError('P1001')).status).toBe(500);
  });

  it('keeps the 4xx of an exposed middleware error (body parser)', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
    });
    expect(normalizeException(tooLarge)).toEqual({
      status: 413,
      message: 'request entity too large',
    });
    // Not marked safe to expose, or not a client error: still a generic 500.
    const hidden = Object.assign(new Error('internal detail'), { status: 400, expose: false });
    expect(normalizeException(hidden).status).toBe(500);
    const server = Object.assign(new Error('upstream'), { status: 502, expose: true });
    expect(normalizeException(server).status).toBe(500);
  });

  it('answers dependency failures as gateway errors, without naming the dependency', () => {
    expect(normalizeException(new ExternalServiceError('billing', 'timeout'))).toEqual({
      status: 504,
      message: 'An upstream service did not answer in time',
    });
    expect(normalizeException(new ExternalServiceError('billing', 'status', 500)).status).toBe(502);
    expect(normalizeException(new ExternalServiceError('billing', 'network')).status).toBe(502);
    expect(normalizeException(new RedisUnavailableError('not connected')).status).toBe(503);
  });

  it('hides anything unexpected behind a generic 500', () => {
    expect(normalizeException(new Error('connection string with password'))).toEqual({
      status: 500,
      message: 'An unexpected error occurred',
    });
    expect(normalizeException('thrown string')).toEqual({
      status: 500,
      message: 'An unexpected error occurred',
    });
  });
});

describe('AllExceptionsFilter', () => {
  it('answers with the error envelope', () => {
    const { host, res } = hostFor({ method: 'GET', originalUrl: '/api/x', id: 'req-1' });
    new AllExceptionsFilter().catch(new BadRequestException('Nope'), host);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ data: null, message: 'Nope' });
  });

  it('logs server errors with the request id and path, never the query string', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, res } = hostFor({
      method: 'POST',
      originalUrl: '/api/things?token=secret',
      id: 'req-2',
    });
    new AllExceptionsFilter().catch(new Error('boom'), host);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(error).toHaveBeenCalledOnce();
    const [line] = error.mock.calls[0] ?? [];
    expect(line).toBe('POST /api/things -> 500 (request req-2, application)');
  });

  it("logs a Prisma error's class, code and frames, never its message (it quotes arguments)", () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = hostFor({ method: 'GET', originalUrl: '/api/users/me', id: 'req-3' });
    new AllExceptionsFilter().catch(
      new Prisma.PrismaClientValidationError(
        'Invalid `prisma.user.findUnique()` invocation:\n{ where: { email: "ada@example.test" } }',
        { clientVersion: 'spec' },
      ),
      host,
    );
    const [, stack] = error.mock.calls[0] ?? [];
    expect(String(stack)).toMatch(/^PrismaClientValidationError\n\s+at /);
    expect(String(stack)).not.toContain('ada@example.test');
  });

  it('does not log client errors', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = hostFor({ method: 'GET', originalUrl: '/api/x' });
    new AllExceptionsFilter().catch(new BadRequestException('Nope'), host);
    expect(error).not.toHaveBeenCalled();
  });

  describe('error tracking', () => {
    const capture = vi.fn();
    beforeEach(() => {
      capture.mockClear();
      setErrorTracker({ ...disabledErrorTracker, enabled: true, capture });
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
      setErrorTracker(disabledErrorTracker);
    });

    it('reports an unexpected error with what identifies the request, never its content', () => {
      const { host } = hostFor({
        method: 'GET',
        originalUrl: '/api/users/7?token=secret',
        id: 'req-3',
        route: { path: '/api/users/:id' },
        user: { id: 'user-1', role: 'member' },
        headers: { authorization: 'Bearer secret' },
      });
      const boom = new Error('boom');
      new AllExceptionsFilter().catch(boom, host);
      expect(capture).toHaveBeenCalledWith(boom, {
        origin: 'application',
        requestId: 'req-3',
        method: 'GET',
        route: '/api/users/:id',
        statusCode: 500,
        userId: 'user-1',
      });
    });

    it('tells a failing dependency from an application bug', () => {
      const { host, res } = hostFor({ method: 'GET', originalUrl: '/api/x', id: 'req-4' });
      new AllExceptionsFilter().catch(new ExternalServiceError('billing', 'timeout'), host);
      expect(res.status).toHaveBeenCalledWith(504);
      expect(capture).toHaveBeenCalledWith(
        expect.any(ExternalServiceError),
        expect.objectContaining({ origin: 'dependency', dependency: 'billing', statusCode: 504 }),
      );
    });

    it('does not report client errors or deliberate 503s', () => {
      for (const exception of [
        new BadRequestException('Nope'),
        new ServiceUnavailableException('Database unreachable'),
      ]) {
        new AllExceptionsFilter().catch(
          exception,
          hostFor({ method: 'GET', originalUrl: '/x' }).host,
        );
      }
      expect(capture).not.toHaveBeenCalled();
    });
  });
});

describe('classifyFailure', () => {
  it('names where a failure came from', () => {
    expect(classifyFailure(new Error('bug'))).toEqual({ origin: 'application', report: true });
    expect(classifyFailure(prismaError('P1001'))).toEqual({ origin: 'database', report: true });
    expect(classifyFailure(new ExternalServiceError('maps', 'status', 502))).toEqual({
      origin: 'dependency',
      dependency: 'maps',
      report: true,
    });
    expect(classifyFailure(new RedisUnavailableError('not connected'))).toEqual({
      origin: 'dependency',
      dependency: 'redis',
      report: true,
    });
    expect(classifyFailure(new ServiceUnavailableException())).toEqual({
      origin: 'unavailable',
      report: false,
    });
  });

  // The pg driver raises a lost or unanswered connection as a plain Error
  // that Prisma passes through (src/prisma/connection-failures.int.spec.ts
  // shows each one against a real database).
  it.each([
    'Connection terminated unexpectedly',
    'Query read timeout',
    'timeout exceeded when trying to connect',
    'Client has encountered a connection error and is not queryable',
  ])('counts the driver error "%s" as a database failure', (message) => {
    expect(classifyFailure(new Error(message))).toEqual({ origin: 'database', report: true });
  });

  it('follows the cause of a wrapped driver error', () => {
    const timeout = new Error('Connection terminated due to connection timeout', {
      cause: new Error('Connection terminated unexpectedly'),
    });
    expect(classifyFailure(timeout).origin).toBe('database');
    expect(classifyFailure(new Error('import failed', { cause: timeout })).origin).toBe('database');
  });

  it('does not take an application error for a database one by a similar message', () => {
    expect(
      classifyFailure(new Error('Connection terminated unexpectedly: retry later')).origin,
    ).toBe('application');
    expect(classifyFailure('Connection terminated unexpectedly').origin).toBe('application');
  });
});

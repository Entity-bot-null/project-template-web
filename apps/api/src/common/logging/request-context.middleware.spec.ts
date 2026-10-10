import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { currentRequestId } from '../../observability/request-context.js';
import {
  clientIp,
  pathOf,
  REQUEST_ID_HEADER,
  requestContext,
} from './request-context.middleware.js';

function exchange(url: string, headers: Record<string, string> = {}) {
  const req = {
    method: 'GET',
    originalUrl: url,
    get: (name: string) => headers[name],
  } as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: vi.fn(),
  }) as unknown as Response & EventEmitter;
  const next = vi.fn<() => void>();
  requestContext(req, res, next);
  return { req, res, next };
}

describe('requestContext', () => {
  it('gives the request a fresh id and echoes it in the response', () => {
    const { req, res, next } = exchange('/api/users');
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, req.id);
    expect(next).toHaveBeenCalledOnce();
  });

  it("keeps a caller's well-formed id and replaces anything else", () => {
    expect(exchange('/api/x', { [REQUEST_ID_HEADER]: 'trace-123.a_b' }).req.id).toBe(
      'trace-123.a_b',
    );
    const injected = exchange('/api/x', { [REQUEST_ID_HEADER]: 'bad id\nFAKE LOG LINE' }).req.id;
    expect(injected).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs one line per request with the path but never the query string', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { res, req } = exchange('/api/users?token=secret');
    res.emit('finish');
    expect(log).toHaveBeenCalledOnce();
    const [line] = log.mock.calls[0] ?? [];
    expect(String(line)).toContain(`GET /api/users 200`);
    expect(String(line)).toContain(req.id);
    expect(String(line)).not.toContain('secret');
  });

  it('names the client address and the caller, once a guard identified one', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { req, res } = exchange('/api/users/me');
    Object.assign(req, { ip: '::ffff:203.0.113.7', user: { id: 'user-1', role: 'member' } });
    res.emit('finish');
    const [line] = log.mock.calls[0] ?? [];
    expect(String(line)).toContain('ip=203.0.113.7 user=user-1');
  });

  it('runs the rest of the request inside its context, access line included', () => {
    let seenByHandler: string | undefined;
    let seenByAccessLog: string | undefined;
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      seenByAccessLog = currentRequestId();
    });
    const req = {
      method: 'GET',
      originalUrl: '/api/users',
      get: (name: string) => (name === REQUEST_ID_HEADER ? 'ctx-1' : undefined),
    } as unknown as Request;
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setHeader: vi.fn(),
    }) as unknown as Response & EventEmitter;
    requestContext(req, res, () => {
      seenByHandler = currentRequestId();
    });
    // The socket emits 'finish' later, from outside the request's async chain.
    res.emit('finish');
    expect(seenByHandler).toBe('ctx-1');
    expect(seenByAccessLog).toBe('ctx-1');
    expect(currentRequestId()).toBeUndefined();
  });

  it('keeps health probes out of the default log level', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    exchange('/api/health/live').res.emit('finish');
    expect(log).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledOnce();
  });
});

describe('pathOf', () => {
  it('drops the query string', () => {
    expect(pathOf({ originalUrl: '/a/b?c=d' } as Request)).toBe('/a/b');
    expect(pathOf({ originalUrl: '/a' } as Request)).toBe('/a');
  });
});

describe('clientIp', () => {
  it('gives IPv4 clients one form, whatever the socket', () => {
    expect(clientIp({ ip: '::ffff:198.51.100.4' } as Request)).toBe('198.51.100.4');
    expect(clientIp({ ip: '198.51.100.4' } as Request)).toBe('198.51.100.4');
    expect(clientIp({ ip: '2001:db8::1' } as Request)).toBe('2001:db8::1');
    expect(clientIp({} as Request)).toBe('unknown');
  });
});

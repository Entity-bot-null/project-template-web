import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RedisUnavailableError } from '../../infrastructure/redis/redis.service.js';
import { errorTracker } from '../../observability/error-tracker.js';
import { type ErrorOrigin, recordServerError } from '../../observability/metrics.js';
import { isDatabaseConnectionFailure } from '../../prisma/connection-failures.js';
import { Prisma } from '../../prisma/generated/client.js';
import { ExternalServiceError } from '../http/external-http.js';
import { pathOf } from '../logging/request-context.middleware.js';

export interface ErrorOutcome {
  status: number;
  message: string;
}

export interface FailureOrigin {
  origin: ErrorOrigin;
  /** The external service or infrastructure that failed, when origin is "dependency". */
  dependency?: string;
  /** Sent to the error tracker: unexpected failures only, not deliberate 5xx answers. */
  report: boolean;
}

// Every error leaves the API as { data: null, message } with its HTTP status
// (docs/error-handling.md). Expected errors (HttpException and the known
// database ones) keep their message; anything else is a 500 with a generic
// message, its detail and stack go to the log only, tied to the request id
// the client received in X-Request-Id.
//
// Every 5xx is also classified by origin (application, database, dependency,
// unavailable): logged, counted (app.server.errors) and, when unexpected,
// reported to the error tracker with the request id, route and release
// (docs/observability.md#error-tracking). The origin answers the first
// question of an incident: our code, our database, or someone else's service.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const { status, message } = normalizeException(exception);

    if (status >= 500) {
      const failure = classifyFailure(exception);
      const route = routeOf(req);
      recordServerError(failure.origin, route);
      const origin =
        failure.dependency === undefined
          ? failure.origin
          : `${failure.origin}: ${failure.dependency}`;
      this.logger.error(
        `${req.method} ${pathOf(req)} -> ${status} (request ${req.id ?? 'unknown'}, ${origin})`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      if (failure.report) {
        errorTracker().capture(exception, {
          origin: failure.origin,
          ...(failure.dependency !== undefined && { dependency: failure.dependency }),
          ...(req.id !== undefined && { requestId: req.id }),
          method: req.method,
          ...(route !== undefined && { route }),
          statusCode: status,
          ...(req.user !== undefined && { userId: req.user.id }),
        });
      }
    }

    res.status(status).json({ data: null, message });
  }
}

export function normalizeException(exception: unknown): ErrorOutcome {
  if (exception instanceof HttpException) {
    return { status: exception.getStatus(), message: httpMessage(exception) };
  }
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    return prismaOutcome(exception);
  }
  if (exception instanceof ExternalServiceError) {
    return exception.kind === 'timeout'
      ? {
          status: HttpStatus.GATEWAY_TIMEOUT,
          message: 'An upstream service did not answer in time',
        }
      : { status: HttpStatus.BAD_GATEWAY, message: 'An upstream service failed' };
  }
  if (exception instanceof RedisUnavailableError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'Service temporarily unavailable, retry later',
    };
  }
  if (isExposedClientError(exception)) {
    return { status: exception.status, message: exception.message };
  }
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'An unexpected error occurred' };
}

/** Where a 5xx came from, and whether it is a failure worth reporting. */
export function classifyFailure(exception: unknown): FailureOrigin {
  if (exception instanceof ExternalServiceError) {
    return { origin: 'dependency', dependency: exception.dependency, report: true };
  }
  if (exception instanceof RedisUnavailableError) {
    return { origin: 'dependency', dependency: 'redis', report: true };
  }
  if (
    exception instanceof Prisma.PrismaClientKnownRequestError ||
    exception instanceof Prisma.PrismaClientUnknownRequestError ||
    exception instanceof Prisma.PrismaClientInitializationError ||
    exception instanceof Prisma.PrismaClientRustPanicError ||
    // A lost connection reaches us as the driver's plain Error.
    isDatabaseConnectionFailure(exception)
  ) {
    return { origin: 'database', report: true };
  }
  // A deliberate 503 or 504 (readiness, a feature switched off) is an answer,
  // not a bug; an explicit 500 is a bug like any other.
  if (exception instanceof HttpException && exception.getStatus() !== 500) {
    return { origin: 'unavailable', report: false };
  }
  return { origin: 'application', report: true };
}

/** The matched route pattern (/api/users/:id): low cardinality, no ids in it. */
export function routeOf(req: Request): string | undefined {
  const path: unknown = (req as { route?: { path?: unknown } }).route?.path;
  return typeof path === 'string' ? path : undefined;
}

// Errors raised by Express middleware before Nest sees the request (the body
// parser: payload too large, unsupported encoding) follow the http-errors
// convention: a 4xx `status`, and `expose: true` when the message is safe to
// show the client.
function isExposedClientError(
  exception: unknown,
): exception is Error & { status: number; expose: true } {
  return (
    exception instanceof Error &&
    'status' in exception &&
    typeof exception.status === 'number' &&
    exception.status >= 400 &&
    exception.status < 500 &&
    'expose' in exception &&
    exception.expose === true
  );
}

function httpMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if (typeof response === 'object' && 'message' in response) {
    const { message } = response as { message?: unknown };
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join(', ');
  }
  return exception.message;
}

// Constraint violations the client can act on. Column and constraint names
// stay out of the message.
function prismaOutcome(exception: Prisma.PrismaClientKnownRequestError): ErrorOutcome {
  switch (exception.code) {
    case 'P2002':
      return { status: HttpStatus.CONFLICT, message: 'A record with this value already exists' };
    case 'P2003':
      return { status: HttpStatus.CONFLICT, message: 'The record is referenced by another record' };
    case 'P2025':
      return { status: HttpStatus.NOT_FOUND, message: 'Record not found' };
    default:
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'An unexpected error occurred' };
  }
}

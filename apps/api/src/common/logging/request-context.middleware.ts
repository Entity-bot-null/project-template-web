import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../../env/env.js';
import { runWithRequestContext } from '../../observability/request-context.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

// A caller (proxy, another service) may pass its own id to correlate logs
// across systems; anything else is replaced, so the header can never inject
// text into the logs.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

const logger = new Logger('HTTP');

// Gives every request an id (echoed in X-Request-Id, kept on req.id for the
// error log) and writes one access line when the response is sent. Only the
// method, the path without its query string (it may carry tokens), the
// status and the duration are logged: never headers, cookies or bodies.
// The rest of the request runs inside a request context
// (observability/request-context.ts): every log line written for it carries
// the id, and so does its trace when tracing is on.
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id = incoming !== undefined && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  // From a support ticket's request id to the trace: search by this attribute.
  trace.getActiveSpan()?.setAttribute('app.request_id', id);

  const started = process.hrtime.bigint();
  const logAccess = () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
    const path = pathOf(req);
    const entry = {
      message: 'request completed',
      requestId: id,
      method: req.method,
      path,
      statusCode: res.statusCode,
      durationMs,
      // Who and from where: what an investigation needs, never what they sent.
      ip: clientIp(req),
      userId: req.user?.id ?? null,
    };
    const line =
      env.LOG_FORMAT === 'json'
        ? entry
        : `${req.method} ${path} ${res.statusCode} ${durationMs}ms ip=${entry.ip} user=${entry.userId ?? '-'} (${id})`;
    // Health probes run every few seconds: kept out of the default level.
    if (path.startsWith('/api/health')) logger.debug(line);
    else logger.log(line);
  };
  runWithRequestContext({ requestId: id }, () => {
    // Bound here, inside the context: the socket's 'finish' event would not
    // see it otherwise.
    res.on('finish', AsyncResource.bind(logAccess));
    next();
  });
}

/**
 * The client address Express resolved through trust proxy. IPv4 clients on a
 * dual-stack socket arrive as ::ffff:a.b.c.d: one form for both.
 */
export function clientIp(req: Request): string {
  const ip = req.ip ?? 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** The request path without the query string. */
export function pathOf(req: Request): string {
  return req.originalUrl.split('?', 1)[0] ?? req.originalUrl;
}

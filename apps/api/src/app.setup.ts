import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { jsonOnly } from './common/http/json-only.middleware.js';
import { malformedJson } from './common/http/malformed-json.middleware.js';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { requestContext } from './common/logging/request-context.middleware.js';
import { env } from './env/env.js';

// The HTTP pipeline, shared by the server (main.ts), the OpenAPI export and
// every integration spec, so tests exercise exactly what production runs.
export function configureApp(app: NestExpressApplication): void {
  // Everything lives under /api. The leading slash matters: without it Nest
  // registers the not-found handler so that unknown /api paths skip the
  // { data, message } envelope.
  app.setGlobalPrefix('/api');
  // Client IP (rate limits, logs) read from X-Forwarded-For only across the
  // hops TRUST_PROXY names. Too generous a value lets a client choose its own
  // IP and escape every rate limit: count the real hops (docs/security.md#https).
  app.set('trust proxy', env.TRUST_PROXY);
  // First, so even rejected requests get an id and an access log line.
  app.use(requestContext);
  // Security headers (nosniff, frame denial, HSTS, CSP, ...).
  app.use(helmet());
  // Responses carry tokens and personal data: browsers and shared caches
  // must never store them.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  if (env.CORS_ORIGINS.length > 0) {
    app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  }
  // JSON bodies only: form posts are refused before parsing (CSRF defense in depth).
  app.use(jsonOnly);
  // Nest's own JSON parser, with its defaults, registered here instead of at
  // init so that a malformed body is answered with one plain message, never
  // the parser's text (common/http/malformed-json.middleware.ts).
  app.useBodyParser('json');
  app.use(malformedJson);
  // The refresh token travels in an httpOnly cookie (auth.constants.ts).
  app.use(cookieParser());
  app.enableShutdownHooks();
  app.useGlobalInterceptors(new TransformInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
}

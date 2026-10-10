import { type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  seconds,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Response } from 'express';

// Rate limiting (docs/security.md#rate-limiting), per client IP and per route,
// by two throttlers that each count every request they apply to:
//   default  every route: RATE_LIMIT_MAX per RATE_LIMIT_WINDOW_SEC;
//   route    only the routes that declare a tighter limit of their own with
//            @RouteRateLimit (sign-in, refresh), on top of the global one:
//            whichever runs out first blocks.
// Never set a route's limit with @Throttle({ default: ... }): that replaces
// the global limit for the route instead of adding to it, so a global limit
// set tighter than the route's would stop applying there.

export const ROUTE_THROTTLER = 'route';

export interface RouteLimit {
  /** Requests per client IP... */
  limit: number;
  /** ...in this many seconds. */
  ttlSec: number;
}

const ROUTE_LIMIT = 'app:route-rate-limit';
const reflector = new Reflector();

/** A tighter limit of the route's own, counted on top of the global limit. */
export const RouteRateLimit = (rule: RouteLimit) => SetMetadata(ROUTE_LIMIT, rule);

function routeLimitOf(context: ExecutionContext): RouteLimit | undefined {
  return reflector.getAllAndOverride<RouteLimit | undefined>(ROUTE_LIMIT, [
    context.getHandler(),
    context.getClass(),
  ]);
}

function declaredRouteLimit(context: ExecutionContext): RouteLimit {
  const rule = routeLimitOf(context);
  // Unreachable: the route throttler skips every route without one.
  if (rule === undefined) throw new Error('This route declares no @RouteRateLimit');
  return rule;
}

/** The ThrottlerModule options: both throttlers, on `storage` (RATE_LIMIT_STORE). */
export function rateLimitOptions(
  storage: ThrottlerStorage,
  global: { limit: number; windowSec: number },
): ThrottlerModuleOptions {
  return {
    throttlers: [
      { name: 'default', limit: global.limit, ttl: seconds(global.windowSec) },
      {
        name: ROUTE_THROTTLER,
        // Routes without a limit of their own keep no counter here at all.
        skipIf: (context) => routeLimitOf(context) === undefined,
        limit: (context) => declaredRouteLimit(context).limit,
        ttl: (context) => seconds(declaredRouteLimit(context).ttlSec),
      },
    ],
    errorMessage: 'Too many requests, retry later',
    storage,
  };
}

// The throttler's guard, answering every 429 with the standard Retry-After,
// whichever throttler blocked: the library names a named throttler's header
// after it (Retry-After-route), which clients do not read.
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(detail.timeToBlockExpire));
    await super.throwThrottlingException(context, detail);
  }
}

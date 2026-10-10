import type { CookieOptions } from 'express';
import type { RouteLimit } from '../common/guards/rate-limit.guard.js';
import { env } from '../env/env.js';

/** Access token lifetime: short, the refresh cookie renews it. */
export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
/** Pinned on the signer and on every verifier. */
export const ACCESS_TOKEN_ALGORITHM = 'HS256';
/** Refresh session lifetime, renewed on every rotation (sliding). */
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
/** A token rotated this recently is a client race (two tabs), not a replay. */
export const REFRESH_REUSE_LEEWAY_SEC = 30;
/** Absolute lifetime of a sign-in: rotations never extend a session past it. */
export const REFRESH_FAMILY_MAX_AGE_SEC = 90 * 24 * 60 * 60;
/** Stale sessions are swept at boot and on this interval. */
export const SESSION_SWEEP_INTERVAL_SEC = 60 * 60;

/** argon2 has no practical input limit; this bounds the work per request. */
export const PASSWORD_MAX_LENGTH = 200;

// Per client IP: credential stuffing protection. Counted on top of the global
// limit (RATE_LIMIT_MAX), not instead of it: both apply, and whichever runs
// out first blocks (@RouteRateLimit, common/guards/rate-limit.guard.ts).
export const SIGN_IN_RATE_LIMIT: RouteLimit = { limit: 10, ttlSec: 60 };
export const REFRESH_RATE_LIMIT: RouteLimit = { limit: 30, ttlSec: 60 };

// In production the refresh cookie carries the __Host- prefix: browsers then
// accept it only when Secure, without Domain and on Path=/, so a site on a
// sibling subdomain cannot plant one of its own (cookie tossing, which would
// sign the victim in to the attacker's account). The price of Path=/ is that
// the cookie also travels with requests outside /api/auth, where nothing
// reads it. Plain HTTP (development, tests) cannot use the prefix, so there
// it is a plain cookie scoped to /api/auth.
const PRODUCTION = env.NODE_ENV === 'production';
export const REFRESH_COOKIE = PRODUCTION ? '__Host-refresh_token' : 'refresh_token';
export const REFRESH_COOKIE_PATH = PRODUCTION ? '/' : '/api/auth';
export const SESSION_HINT_COOKIE = 'has_session';

// The refresh token: httpOnly (scripts never see it), Secure in production,
// SameSite from AUTH_COOKIE_SAMESITE. It expires with its session row.
export function refreshCookieOptions(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: PRODUCTION,
    sameSite: env.AUTH_COOKIE_SAMESITE,
    path: REFRESH_COOKIE_PATH,
    ...(expiresAt && { expires: expiresAt }),
  };
}

// A readable companion holding no secret, only the fact that a refresh is
// worth trying: the web app skips its boot refresh (and the 401 an anonymous
// visitor would collect) when it is absent. Set and cleared together with the
// refresh cookie.
export function sessionHintCookieOptions(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: false,
    secure: PRODUCTION,
    sameSite: env.AUTH_COOKIE_SAMESITE,
    path: '/',
    ...(expiresAt && { expires: expiresAt }),
  };
}

// Emails are compared case-insensitively but stored in a case-sensitive
// unique column, so every write and lookup goes through this first.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

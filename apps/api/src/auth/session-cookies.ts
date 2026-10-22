import type { Request, Response } from 'express';
import type { ApiEnvelope } from '../common/interceptors/transform.interceptor.js';
import {
  REFRESH_COOKIE,
  refreshCookieOptions,
  SESSION_HINT_COOKIE,
  sessionHintCookieOptions,
} from './auth.constants.js';
import type { SignInResult } from './auth.service.js';
import type { AuthSession } from './dto/auth.schemas.js';

/**
 * Answers with a new session: the refresh token as its httpOnly cookie, the
 * readable session hint, the access token in the body. Sign-in, refresh and a
 * password change (which starts a new session for this browser) answer alike.
 */
export function respondWithSession(
  res: Response,
  { session, refresh }: SignInResult,
  message: string,
): ApiEnvelope<AuthSession> {
  res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions(refresh.expiresAt));
  setSessionHint(res, refresh.expiresAt);
  return { data: session, message };
}

/** The readable hint that a session lives, until it expires (see respondWithSession). */
export function setSessionHint(res: Response, expiresAt: Date): void {
  res.cookie(SESSION_HINT_COOKIE, '1', sessionHintCookieOptions(expiresAt));
}

// A browser deletes a cookie by name, domain and path, so clearing uses the
// same options it was set with.
export function clearSessionCookies(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
  res.clearCookie(SESSION_HINT_COOKIE, sessionHintCookieOptions());
}

// Two refresh cookies (a parent-domain cookie a sibling site planted next to
// ours, for instance) are never guessed between: whichever one the parser
// keeps could be an attacker's session.
export function hasAmbiguousRefreshCookie(req: Request): boolean {
  const names = (req.get('Cookie') ?? '').split(';').map((pair) => pair.split('=', 1)[0]?.trim());
  return names.filter((name) => name === REFRESH_COOKIE).length > 1;
}

/** The request's refresh token: undefined when absent or ambiguous. */
export function refreshTokenOf(req: Request): string | undefined {
  if (hasAmbiguousRefreshCookie(req)) return undefined;
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** How many refresh cookies of one request a logout tries (refreshTokensOf). */
const MAX_REFRESH_COOKIES = 4;

/**
 * Every refresh token the request's Cookie header carries, in order: more
 * than one when a cookie was planted next to ours. Only for a logout that
 * names the sessions it ends, which cannot end another one by trying it.
 */
export function refreshTokensOf(req: Request): string[] {
  const tokens: string[] = [];
  for (const pair of (req.get('Cookie') ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1 || pair.slice(0, separator).trim() !== REFRESH_COOKIE) continue;
    const value = decodedCookie(pair.slice(separator + 1).trim());
    if (value.length > 0) tokens.push(value);
  }
  return tokens.slice(0, MAX_REFRESH_COOKIES);
}

// As the cookie parser reads a value: percent-decoded, kept as written when
// that fails.
function decodedCookie(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

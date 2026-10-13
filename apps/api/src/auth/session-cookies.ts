import type { Response } from 'express';
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
  res.cookie(SESSION_HINT_COOKIE, '1', sessionHintCookieOptions(refresh.expiresAt));
  return { data: session, message };
}

// A browser deletes a cookie by name, domain and path, so clearing uses the
// same options it was set with.
export function clearSessionCookies(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
  res.clearCookie(SESSION_HINT_COOKIE, sessionHintCookieOptions());
}

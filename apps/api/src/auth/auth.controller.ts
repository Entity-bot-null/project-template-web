import { Body, Controller, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RouteRateLimit } from '../common/guards/rate-limit.guard.js';
import type { ApiEnvelope } from '../common/interceptors/transform.interceptor.js';
import { ApiData, ApiErrors, ZodBody } from '../common/openapi/index.js';
import {
  REFRESH_COOKIE,
  REFRESH_RATE_LIMIT,
  refreshCookieOptions,
  SESSION_HINT_COOKIE,
  SIGN_IN_RATE_LIMIT,
  sessionHintCookieOptions,
} from './auth.constants.js';
import { AuthService, type SignInResult } from './auth.service.js';
import {
  type AuthSession,
  AuthSessionSchema,
  type SignInDto,
  SignInSchema,
} from './dto/auth.schemas.js';
import { RefreshRaceLostException } from './sessions.service.js';

// Cross-site requests never reach these routes: the global Fetch Metadata
// guard refuses them first (CSRF), and only JSON bodies are accepted.
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('sign-in')
  @HttpCode(200)
  @RouteRateLimit(SIGN_IN_RATE_LIMIT)
  @ApiOperation({
    summary: 'Sign in with email and password',
    description:
      'Returns a short-lived access token and sets the refresh token as an httpOnly cookie: __Host-refresh_token on Path=/ in production (Secure), refresh_token scoped to /api/auth elsewhere. A session this browser already had is ended.',
  })
  @ZodBody(SignInSchema)
  @ApiData(AuthSessionSchema)
  @ApiErrors(400, 401, 403)
  async signIn(
    @Body() body: SignInDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiEnvelope<AuthSession>> {
    const result = await this.auth.signIn(body.email, body.password, refreshTokenOf(req));
    return respond(res, result, 'Signed in');
  }

  // A good token is rotated (new cookie, new access token). When the server
  // says the session is gone (401) the cookies are cleared, so the client
  // stops retrying; three exceptions keep them: two refresh cookies (clearing
  // removes only ours, and the next refresh would then use the planted one),
  // losing a race against another refresh of the same token (the winner's
  // cookie is already in the jar), and any server failure (the session may be
  // fine: a database failover must not sign everyone out).
  @Post('refresh')
  @HttpCode(200)
  @RouteRateLimit(REFRESH_RATE_LIMIT)
  @ApiOperation({
    summary: 'Rotate the refresh cookie and mint a new access token',
    description:
      'Reads the refresh cookie (__Host-refresh_token in production, refresh_token elsewhere). Each refresh token works once; presenting one that was rotated more than 30 seconds ago ends its whole session family.',
  })
  @ApiData(AuthSessionSchema)
  @ApiErrors(401, 403)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiEnvelope<AuthSession>> {
    if (hasAmbiguousRefreshCookie(req)) {
      throw new UnauthorizedException('Ambiguous session cookies');
    }
    try {
      const token = refreshTokenOf(req);
      if (token === undefined) throw new UnauthorizedException('Missing refresh token');
      return respond(res, await this.auth.refresh(token), 'Session refreshed');
    } catch (error) {
      if (error instanceof UnauthorizedException && !(error instanceof RefreshRaceLostException)) {
        clearSessionCookies(res);
      }
      throw error;
    }
  }

  // Idempotent: the presented token's whole family is revoked if known, then
  // the cookies are cleared. When the database cannot be reached the cookies
  // stay: the family is still live, and the client's retry needs the cookie
  // to end it (a cleared one would make the retry a no-op that reads as done).
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'End the current session family and clear the cookies' })
  @ApiResponse({ status: 204, description: 'Signed out' })
  @ApiErrors(403)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = refreshTokenOf(req);
    if (token !== undefined) await this.auth.logout(token);
    clearSessionCookies(res);
  }
}

// Two refresh cookies (a parent-domain cookie a sibling site planted next to
// ours, for instance) are never guessed between: whichever one the parser
// keeps could be an attacker's session.
function hasAmbiguousRefreshCookie(req: Request): boolean {
  const names = (req.get('Cookie') ?? '').split(';').map((pair) => pair.split('=', 1)[0]?.trim());
  return names.filter((name) => name === REFRESH_COOKIE).length > 1;
}

/** The request's refresh token: undefined when absent or ambiguous. */
function refreshTokenOf(req: Request): string | undefined {
  if (hasAmbiguousRefreshCookie(req)) return undefined;
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function respond(
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
function clearSessionCookies(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
  res.clearCookie(SESSION_HINT_COOKIE, sessionHintCookieOptions());
}

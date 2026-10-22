import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RouteRateLimit } from '../common/guards/rate-limit.guard.js';
import type { ApiEnvelope } from '../common/interceptors/transform.interceptor.js';
import { ApiData, ApiErrors, ZodBody } from '../common/openapi/index.js';
import {
  PASSWORD_RESET_CONFIRM_RATE_LIMIT,
  PASSWORD_RESET_REQUEST_RATE_LIMIT,
  REFRESH_RATE_LIMIT,
  SIGN_IN_RATE_LIMIT,
  SIGN_UP_CONFIRM_RATE_LIMIT,
  SIGN_UP_RATE_LIMIT,
} from './auth.constants.js';
import { AuthService } from './auth.service.js';
import {
  type AuthCapabilities,
  AuthCapabilitiesSchema,
  type AuthSession,
  AuthSessionSchema,
  type LogoutDto,
  LogoutSchema,
  type PasswordResetConfirmDto,
  PasswordResetConfirmSchema,
  type PasswordResetRequestDto,
  PasswordResetRequestSchema,
  type SignInDto,
  SignInSchema,
  type SignUpConfirmDto,
  SignUpConfirmSchema,
  type SignUpDto,
  SignUpSchema,
} from './dto/auth.schemas.js';
import { PasswordResetService } from './password-reset.service.js';
import { RefreshRaceLostException } from './sessions.service.js';
import {
  clearSessionCookies,
  hasAmbiguousRefreshCookie,
  refreshTokenOf,
  respondWithSession,
  setSessionHint,
} from './session-cookies.js';
import { SignUpService } from './sign-up.service.js';

// Cross-site requests never reach these routes: the global Fetch Metadata
// guard refuses them first (CSRF), and only JSON bodies are accepted.
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passwordReset: PasswordResetService,
    private readonly signUp: SignUpService,
  ) {}

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
    return respondWithSession(res, result, 'Signed in');
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
      return respondWithSession(res, await this.auth.refresh(token), 'Session refreshed');
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
  // A logout that names its sessions touches the cookies only when it ended
  // one of them: the jar then holds a session started meanwhile, whose hint
  // the client may have dropped already (it drops it first), so a live one
  // gets it back.
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({
    summary: 'End the current session family and clear the cookies',
    description:
      "Without sessionIds, ends the refresh cookie's session, whichever it is. With them, ends it only when it is one of those sessions (AuthSession.sessionId), and clears the cookies only then; a live session started meanwhile is left alone, with its session hint set again.",
  })
  @ZodBody(LogoutSchema, { required: false })
  @ApiResponse({ status: 204, description: 'Signed out' })
  @ApiErrors(400, 403)
  async logout(
    @Body() body: LogoutDto | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = refreshTokenOf(req);
    const only = body?.sessionIds;
    if (only === undefined) {
      if (token !== undefined) await this.auth.logout(token);
      clearSessionCookies(res);
      return;
    }
    if (token === undefined) return;
    const outcome = await this.auth.logout(token, only);
    if (outcome.retired) clearSessionCookies(res);
    else if (outcome.liveUntil !== undefined) setSessionHint(res, outcome.liveUntil);
  }

  // Public and the same for everyone: the web app shows only what works here.
  @Get('capabilities')
  @ApiOperation({
    summary:
      'What this deployment offers: password recovery, public sign-up, change of email, invitations',
  })
  @ApiData(AuthCapabilitiesSchema)
  capabilities(): AuthCapabilities {
    return {
      passwordReset: this.passwordReset.available,
      signUp: this.signUp.available,
      // These need email only: the same answer as passwordReset.
      emailChange: this.passwordReset.available,
      invitations: this.passwordReset.available,
    };
  }

  // Public sign-up (docs/security.md#sign-up), when SIGN_UP_ENABLED. The same
  // answer, at the same speed, whether the address has an account or not.
  @Post('sign-ups')
  @HttpCode(202)
  @RouteRateLimit(SIGN_UP_RATE_LIMIT)
  @ApiOperation({
    summary: 'Sign up: ask for a confirmation link',
    description:
      'Answers 202 for any well-formed request whose password follows the policy. A new address gets a one-time link (valid 24 hours) to confirm it; one that already has an account gets a notice to its owner instead. No account exists until the link is confirmed. 400: the password is refused (too short, too common, too easy to guess, or containing the email or name). 403: sign-up is closed here.',
  })
  @ZodBody(SignUpSchema)
  @ApiResponse({ status: 202, description: 'Accepted' })
  @ApiErrors(400, 403)
  requestSignUp(@Body() body: SignUpDto): void {
    this.signUp.request(body);
  }

  @Post('sign-ups/confirm')
  @HttpCode(200)
  @RouteRateLimit(SIGN_UP_CONFIRM_RATE_LIMIT)
  @ApiOperation({
    summary: "Confirm a sign-up with its link's token and its password",
    description:
      'Creates the account and signs it in, like a sign-in (refresh cookie, access token). 401: not the password chosen at sign-up (a few wrong ones drop the sign-up). 403: sign-up is closed here. 404: the link is invalid, replaced, used or expired. 409: the address got an account meanwhile.',
  })
  @ZodBody(SignUpConfirmSchema)
  @ApiData(AuthSessionSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  async confirmSignUp(
    @Body() body: SignUpConfirmDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiEnvelope<AuthSession>> {
    const result = await this.signUp.confirm(body.token, body.password, refreshTokenOf(req));
    return respondWithSession(res, result, 'Account created');
  }

  // The same answer, at the same speed, for every address: whether it has an
  // account is never told (docs/security.md#password-recovery). Each address
  // gets at most one message a minute and a few a day (the outbox).
  @Post('password-resets')
  @HttpCode(204)
  @RouteRateLimit(PASSWORD_RESET_REQUEST_RATE_LIMIT)
  @ApiOperation({
    summary: 'Ask for a password reset link',
    description:
      'Answers 204 for any well-formed address. If it has an account, a message with a one-time link (valid 30 minutes) is on its way. 503 when this deployment sends no email.',
  })
  @ZodBody(PasswordResetRequestSchema)
  @ApiResponse({ status: 204, description: 'Accepted' })
  @ApiErrors(400, 403, 503)
  requestPasswordReset(@Body() body: PasswordResetRequestDto): void {
    this.passwordReset.request(body.email);
  }

  @Post('password-resets/confirm')
  @HttpCode(204)
  @RouteRateLimit(PASSWORD_RESET_CONFIRM_RATE_LIMIT)
  @ApiOperation({
    summary: "Choose a new password with a reset link's token",
    description:
      'The token works once. Every session of the account ends; nobody is signed in. 400: the new password is refused (too short, too common, too easy to guess, or containing the email or name), the link still works. 404: the link is invalid, used or expired.',
  })
  @ZodBody(PasswordResetConfirmSchema)
  @ApiResponse({ status: 204, description: 'Password changed' })
  @ApiErrors(400, 403, 404)
  async confirmPasswordReset(@Body() body: PasswordResetConfirmDto): Promise<void> {
    await this.passwordReset.confirm(body.token, body.password);
  }
}

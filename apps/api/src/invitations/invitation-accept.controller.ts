import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { INVITATION_ACCEPT_RATE_LIMIT } from '../auth/auth.constants.js';
import {
  type AuthSession,
  AuthSessionSchema,
  type InvitationAcceptDto,
  InvitationAcceptSchema,
} from '../auth/dto/auth.schemas.js';
import { refreshTokenOf, respondWithSession } from '../auth/session-cookies.js';
import { RouteRateLimit } from '../common/guards/rate-limit.guard.js';
import type { ApiEnvelope } from '../common/interceptors/transform.interceptor.js';
import { ApiData, ApiErrors, ZodBody } from '../common/openapi/index.js';
import { InvitationsService } from './invitations.service.js';

// The invitation's link, opened from the invited mailbox in a browser that
// is not signed in (or is, as someone else): the token is the credential.
// Under /api/auth, where the web app sends no access token. Cross-site
// requests never reach it: the global Fetch Metadata guard refuses them.
@ApiTags('auth')
@Controller('auth/invitations')
export class InvitationAcceptController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('accept')
  @HttpCode(200)
  @RouteRateLimit(INVITATION_ACCEPT_RATE_LIMIT)
  @ApiOperation({
    summary: "Accept an invitation with its link's token, choosing a name and a password",
    description:
      "Creates the account with the invitation's role and signs it in, like a sign-in (refresh cookie, access token). 400: the password is refused (too short, too common, too easy to guess, or containing the email or name); the link still works. 404: the invitation is invalid, replaced, revoked, used or expired. 409: the address got an account meanwhile.",
  })
  @ZodBody(InvitationAcceptSchema)
  @ApiData(AuthSessionSchema)
  @ApiErrors(400, 403, 404, 409)
  async accept(
    @Body() body: InvitationAcceptDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiEnvelope<AuthSession>> {
    const result = await this.invitations.accept(
      body.token,
      body.name,
      body.password,
      refreshTokenOf(req),
    );
    return respondWithSession(res, result, 'Invitation accepted');
  }
}

import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PASSWORD_CHANGE_RATE_LIMIT } from '../auth/auth.constants.js';
import { Auth } from '../auth/auth.decorator.js';
import {
  type AuthSession,
  AuthSessionSchema,
  type ChangePasswordDto,
  ChangePasswordSchema,
} from '../auth/dto/auth.schemas.js';
import { respondWithSession } from '../auth/session-cookies.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { RouteRateLimit } from '../common/guards/rate-limit.guard.js';
import type { ApiEnvelope } from '../common/interceptors/transform.interceptor.js';
import { ApiData, ApiErrors, ZodBody } from '../common/openapi/index.js';
import type { RequestUser } from '../common/types/request-user.js';
import { AccountService } from './account.service.js';

// The signed-in person's own account. Under /api/account, not /api/auth: the
// web app sends the access token to every route outside /api/auth/.
@ApiTags('account')
@Controller('account')
@Auth()
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Post('password')
  @HttpCode(200)
  @RouteRateLimit(PASSWORD_CHANGE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Change the password, confirming the current one',
    description:
      'Every other session ends; this browser gets a new session (a new access token in the body and a new refresh cookie). 400: the new password is refused (too short, too common, too easy to guess, or containing the email or name). 403: the current password is wrong. 409: the password changed meanwhile.',
  })
  @ZodBody(ChangePasswordSchema)
  @ApiData(AuthSessionSchema)
  @ApiErrors(400, 403, 409)
  async changePassword(
    @CurrentUser() user: RequestUser,
    @Body() body: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiEnvelope<AuthSession>> {
    const result = await this.account.changePassword(
      user.id,
      body.currentPassword,
      body.newPassword,
    );
    return respondWithSession(res, result, 'Password changed');
  }
}

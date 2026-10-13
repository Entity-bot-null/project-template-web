import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { EMAIL_CHANGE_LINK_RATE_LIMIT } from '../auth/auth.constants.js';
import {
  type EmailChangeConfirmDto,
  EmailChangeConfirmSchema,
  type EmailRevertDto,
  EmailRevertSchema,
} from '../auth/dto/auth.schemas.js';
import { RouteRateLimit } from '../common/guards/rate-limit.guard.js';
import { ApiErrors, ZodBody } from '../common/openapi/index.js';
import { EmailChangeService } from './email-change.service.js';

// The two links of a change of email, opened from a mailbox, possibly in a
// browser that is not signed in: the token is the credential. Under
// /api/auth, where the web app sends no access token. Cross-site requests
// never reach them: the global Fetch Metadata guard refuses them first.
@ApiTags('auth')
@Controller('auth/email-changes')
export class EmailChangeController {
  constructor(private readonly emailChange: EmailChangeService) {}

  @Post('confirm')
  @HttpCode(204)
  @RouteRateLimit(EMAIL_CHANGE_LINK_RATE_LIMIT)
  @ApiOperation({
    summary: 'Confirm a new email address with the link sent to it',
    description:
      'The token works once, while the account is as it was when the link was sent. The address changes, every session ends (sign in again with the new address), and the previous address gets a notice with a link to undo it. 404: the link is invalid, used or expired. 409: the new address got an account meanwhile.',
  })
  @ZodBody(EmailChangeConfirmSchema)
  @ApiResponse({ status: 204, description: 'Address changed' })
  @ApiErrors(400, 403, 404, 409)
  async confirm(@Body() body: EmailChangeConfirmDto): Promise<void> {
    await this.emailChange.confirm(body.token);
  }

  @Post('revert')
  @HttpCode(204)
  @RouteRateLimit(EMAIL_CHANGE_LINK_RATE_LIMIT)
  @ApiOperation({
    summary: 'Undo a change of email with the link sent to the previous address',
    description:
      'The token works once, for 7 days, whatever happened to the account since. The previous address comes back with the new password given here, and every session ends. 400: the password is refused (too short, too common, too easy to guess, or containing the email or name); the link still works. 404: the link is invalid, used or expired. 409: the previous address got another account meanwhile.',
  })
  @ZodBody(EmailRevertSchema)
  @ApiResponse({ status: 204, description: 'Change undone' })
  @ApiErrors(400, 403, 404, 409)
  async revert(@Body() body: EmailRevertDto): Promise<void> {
    await this.emailChange.revert(body.token, body.password);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { INVITATION_RATE_LIMIT } from '../auth/auth.constants.js';
import { Auth } from '../auth/auth.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { RouteRateLimit } from '../common/guards/rate-limit.guard.js';
import { ApiData, ApiErrors, ZodBody, ZodQuery } from '../common/openapi/index.js';
import { type PageQuery, PageQuerySchema } from '../common/pagination.js';
import type { RequestUser } from '../common/types/request-user.js';
import {
  type CreateInvitationDto,
  CreateInvitationSchema,
  InvitationPageSchema,
  InvitationSchema,
} from './dto/invitation.schemas.js';
import { InvitationsService } from './invitations.service.js';

// Administrators only: the guard checks the role on every route, whatever the
// web app shows (docs/authorization.md).
@ApiTags('invitations')
@Controller('admin/invitations')
@Auth('admin')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @HttpCode(201)
  @RouteRateLimit(INVITATION_RATE_LIMIT)
  @ApiOperation({
    summary: 'Invite an address to create an account with a role',
    description:
      'Sends a one-time link (valid 7 days); the account exists once it is accepted with a name and a password the person chooses. Inviting an address again replaces its invitation and link. 409: the address has an account. 429: the address got a message moments ago (or several today). 503: this deployment sends no email.',
  })
  @ZodBody(CreateInvitationSchema)
  @ApiData(InvitationSchema, { status: 201 })
  @ApiErrors(400, 403, 409, 429, 503)
  invite(@CurrentUser() admin: RequestUser, @Body() body: CreateInvitationDto) {
    return this.invitations.invite(admin.id, body);
  }

  @Get()
  @ApiOperation({ summary: 'Pending invitations, newest first' })
  @ZodQuery(PageQuerySchema)
  @ApiData(InvitationPageSchema)
  @ApiErrors(400, 403)
  list(@Query() query: PageQuery) {
    return this.invitations.list(query);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke an invitation: its link stops working at once' })
  @ApiResponse({ status: 204, description: 'Revoked' })
  @ApiErrors(400, 403, 404)
  async revoke(
    @CurrentUser() admin: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.invitations.revoke(admin.id, id);
  }
}

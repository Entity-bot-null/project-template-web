import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, RequireRoles } from '../auth/auth.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ApiData, ApiErrors, ZodQuery } from '../common/openapi/index.js';
import { type PageQuery, PageQuerySchema } from '../common/pagination.js';
import type { RequestUser } from '../common/types/request-user.js';
import { UserPageSchema, UserSchema } from './dto/user.schemas.js';
import { UsersService } from './users.service.js';

// Three access levels on one resource: any signed-in user (me), admins only
// (list) and per record (by id: the owner or an admin).
@ApiTags('users')
@Controller('users')
@Auth()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user' })
  @ApiData(UserSchema)
  @ApiErrors(404)
  me(@CurrentUser() actor: RequestUser) {
    return this.users.me(actor.id);
  }

  @Get()
  @RequireRoles('admin')
  @ApiOperation({ summary: 'List users, newest first (admins only)' })
  @ZodQuery(PageQuerySchema)
  @ApiData(UserPageSchema)
  @ApiErrors(400)
  list(@Query() query: PageQuery) {
    return this.users.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One user',
    description: 'Members may read only themselves; any other id answers 404. Admins read any.',
  })
  @ApiData(UserSchema)
  @ApiErrors(400, 404)
  findOne(@CurrentUser() actor: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.findVisible(actor, id);
  }
}

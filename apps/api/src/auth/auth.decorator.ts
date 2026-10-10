import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { errorResponse } from '../common/openapi/api.decorators.js';
import type { Role } from '../common/types/request-user.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { Roles, RolesGuard } from './roles.guard.js';

// The one way to protect a route: a valid bearer token, then a role check
// when roles are given (none = any signed-in user). Also documents the bearer
// scheme and the 401/403 in OpenAPI. Roles are only written when given, so a
// handler-level @Auth() inside an @Auth('admin') controller inherits the
// admin requirement instead of loosening it.
export function Auth(...roles: Role[]) {
  return applyDecorators(
    UseGuards(JwtAuthGuard, RolesGuard),
    ...(roles.length > 0 ? roleRequirement(roles) : []),
    ApiBearerAuth(),
    ApiResponse(errorResponse(401)),
  );
}

/**
 * Narrows one handler of an @Auth() controller to roles. The controller's
 * guards already run for it: @Auth(...roles) on the handler would register
 * them, and run them, a second time.
 */
export function RequireRoles(...roles: [Role, ...Role[]]) {
  return applyDecorators(...roleRequirement(roles));
}

function roleRequirement(roles: Role[]) {
  return [Roles(...roles), ApiResponse(errorResponse(403))];
}

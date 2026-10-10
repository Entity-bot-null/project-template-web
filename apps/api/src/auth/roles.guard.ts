import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Role } from '../common/types/request-user.js';

export const ROLES_KEY = 'roles';

/** Roles allowed on a route or controller. Use @Auth(...roles), which sets this. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

// Runs after JwtAuthGuard and checks the caller's role against @Roles(): a
// handler's list wins over its controller's, and no list means any signed-in
// user. Object-level checks (may this caller see this record?) belong in the
// service, next to the query (docs/security.md#authorization).
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;
    const { user } = context.switchToHttp().getRequest<Request>();
    if (!user) throw new UnauthorizedException('Not authenticated');
    if (!roles.includes(user.role)) throw new ForbiddenException('Not allowed for this role');
    return true;
  }
}

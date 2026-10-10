import { type ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { RequestUser } from '../common/types/request-user.js';
import { Roles, RolesGuard } from './roles.guard.js';

// Stand-ins for controllers: only their metadata matters.
class OpenController {
  handler(): void {
    // route handler
  }
}

@Roles('admin')
class AdminController {
  handler(): void {
    // route handler
  }

  @Roles('member', 'admin')
  relaxed(): void {
    // route handler
  }
}

function contextFor(
  controller: new () => object,
  handler: string,
  user?: RequestUser,
): ExecutionContext {
  const prototype = controller.prototype as Record<string, unknown>;
  return {
    getClass: () => controller,
    getHandler: () => prototype[handler],
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const guard = new RolesGuard(new Reflector());
const member: RequestUser = { id: 'u1', role: 'member' };
const admin: RequestUser = { id: 'u2', role: 'admin' };

describe('RolesGuard', () => {
  it('allows any signed-in user when no roles are required', () => {
    expect(guard.canActivate(contextFor(OpenController, 'handler', member))).toBe(true);
  });

  it('enforces the controller roles', () => {
    expect(guard.canActivate(contextFor(AdminController, 'handler', admin))).toBe(true);
    expect(() => guard.canActivate(contextFor(AdminController, 'handler', member))).toThrow(
      ForbiddenException,
    );
  });

  it('lets a handler list override its controller', () => {
    expect(guard.canActivate(contextFor(AdminController, 'relaxed', member))).toBe(true);
  });

  it('answers 401, not 403, when no caller is attached', () => {
    expect(() => guard.canActivate(contextFor(AdminController, 'handler'))).toThrow(
      UnauthorizedException,
    );
  });
});

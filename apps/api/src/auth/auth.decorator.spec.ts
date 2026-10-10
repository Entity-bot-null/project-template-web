import { describe, expect, it } from 'vitest';
import { UsersController } from '../users/users.controller.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { ROLES_KEY, RolesGuard } from './roles.guard.js';

// Where Nest keeps the guards of @UseGuards (GUARDS_METADATA).
const GUARDS = '__guards__';

describe('route protection', () => {
  it('runs the guards once per request: on the controller, never again on a handler', () => {
    expect(Reflect.getMetadata(GUARDS, UsersController)).toEqual([JwtAuthGuard, RolesGuard]);
    for (const handler of ['me', 'list', 'findOne'] as const) {
      expect(Reflect.getMetadata(GUARDS, UsersController.prototype[handler])).toBeUndefined();
    }
  });

  it("narrows one handler to a role without loosening the controller's", () => {
    expect(Reflect.getMetadata(ROLES_KEY, UsersController.prototype.list)).toEqual(['admin']);
    expect(Reflect.getMetadata(ROLES_KEY, UsersController.prototype.findOne)).toBeUndefined();
  });
});

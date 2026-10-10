import {
  createParamDecorator,
  type ExecutionContext,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { RequestUser } from '../types/request-user.js';

// The caller an auth guard attached to the request. Reaching the throw means
// a route uses @CurrentUser() without @Auth(): a wiring bug, answered as 401
// (never a 500, never a request served as nobody) and logged.
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    const { user } = ctx.switchToHttp().getRequest<Request>();
    if (!user) {
      new Logger('CurrentUser').error(
        `${ctx.getClass().name}.${ctx.getHandler().name} reads @CurrentUser() without @Auth()`,
      );
      throw new UnauthorizedException('Not authenticated');
    }
    return user;
  },
);

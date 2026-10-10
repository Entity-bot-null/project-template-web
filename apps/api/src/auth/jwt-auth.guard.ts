import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { env } from '../env/env.js';
import { ACCESS_TOKEN_ALGORITHM } from './auth.constants.js';
import { AccessTokenPayloadSchema } from './dto/auth.schemas.js';

// RFC 7235: the scheme is case-insensitive.
const BEARER = /^Bearer\s+(\S+)\s*$/i;

// Authenticates a request from its bearer access token and puts the caller on
// req.user for @CurrentUser(). Verification is offline (signature, expiry,
// claims shape): no database lookup per request, which is why a role change
// or a revocation applies at the next refresh. Role checks are RolesGuard's.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = BEARER.exec(req.get('Authorization') ?? '')?.[1];
    if (token === undefined) throw new UnauthorizedException('Missing access token');

    const payload = AccessTokenPayloadSchema.safeParse(await this.verify(token));
    if (!payload.success) throw new UnauthorizedException('Invalid or expired access token');

    req.user = { id: payload.data.sub, role: payload.data.role };
    return true;
  }

  // The current secret, then the previous one while a rotation is in progress
  // (JWT_ACCESS_SECRET_PREVIOUS): tokens it signed stay valid until they
  // expire, so a planned rotation signs nobody out (docs/security.md#secret-rotation).
  private async verify(token: string): Promise<object> {
    const secrets = [env.JWT_ACCESS_SECRET, env.JWT_ACCESS_SECRET_PREVIOUS].filter(
      (secret) => secret !== undefined,
    );
    for (const secret of secrets) {
      try {
        // The algorithm is pinned here as well as in the module, so a
        // differently configured JwtService can never loosen this guard.
        return await this.jwt.verifyAsync<object>(token, {
          algorithms: [ACCESS_TOKEN_ALGORITHM],
          secret,
        });
      } catch {
        // Wrong secret, expired or malformed: the next secret, or a 401.
      }
    }
    throw new UnauthorizedException('Invalid or expired access token');
  }
}

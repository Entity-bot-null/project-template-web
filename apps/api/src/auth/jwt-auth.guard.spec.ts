import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const env = vi.hoisted(() => ({
  JWT_ACCESS_SECRET: 'spec-only-current-secret-'.padEnd(64, '0'),
  JWT_ACCESS_SECRET_PREVIOUS: undefined as string | undefined,
}));
vi.mock('../env/env.js', () => ({ env }));

const PREVIOUS = 'spec-only-previous-secret-'.padEnd(64, '0');
const USER_ID = '0190b6a1-0000-7000-8000-000000000001';
const signer = (secret: string) =>
  new JwtService({ secret, signOptions: { algorithm: 'HS256', expiresIn: 60 } });
const jwt = signer(env.JWT_ACCESS_SECRET);
const guard = new JwtAuthGuard(jwt);

function contextWith(authorization?: string) {
  const req = {
    get: (name: string) => (name === 'Authorization' ? authorization : undefined),
  } as unknown as Request;
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { context, req };
}

afterEach(() => {
  env.JWT_ACCESS_SECRET_PREVIOUS = undefined;
});

describe('JwtAuthGuard', () => {
  it('puts the caller of a valid token on the request', async () => {
    const token = await jwt.signAsync({ sub: USER_ID, role: 'admin' });
    const { context, req } = contextWith(`Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({ id: USER_ID, role: 'admin' });
  });

  it('accepts the scheme in any case', async () => {
    const token = await jwt.signAsync({ sub: USER_ID, role: 'member' });
    await expect(guard.canActivate(contextWith(`bearer ${token}`).context)).resolves.toBe(true);
  });

  it('refuses a request without a bearer token', async () => {
    await expect(guard.canActivate(contextWith().context)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(contextWith('Basic abc').context)).rejects.toThrow(
      'Missing access token',
    );
  });

  it('refuses a token signed with another secret, or expired', async () => {
    const forged = await signer('x'.repeat(64)).signAsync({ sub: USER_ID, role: 'admin' });
    await expect(guard.canActivate(contextWith(`Bearer ${forged}`).context)).rejects.toThrow(
      'Invalid or expired access token',
    );
    const expired = await jwt.signAsync({ sub: USER_ID, role: 'admin' }, { expiresIn: -10 });
    await expect(guard.canActivate(contextWith(`Bearer ${expired}`).context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepts a token signed with the previous secret only while a rotation is in progress', async () => {
    const old = await signer(PREVIOUS).signAsync({ sub: USER_ID, role: 'member' });
    await expect(guard.canActivate(contextWith(`Bearer ${old}`).context)).rejects.toThrow(
      UnauthorizedException,
    );
    env.JWT_ACCESS_SECRET_PREVIOUS = PREVIOUS;
    await expect(guard.canActivate(contextWith(`Bearer ${old}`).context)).resolves.toBe(true);
  });

  it('refuses a token signed with another algorithm, even with the right secret', async () => {
    const other = await jwt.signAsync({ sub: USER_ID, role: 'admin' }, { algorithm: 'HS512' });
    await expect(guard.canActivate(contextWith(`Bearer ${other}`).context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a validly signed token whose claims are not ours', async () => {
    const odd = await jwt.signAsync({ sub: 'not-a-uuid', role: 'root' });
    await expect(guard.canActivate(contextWith(`Bearer ${odd}`).context)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

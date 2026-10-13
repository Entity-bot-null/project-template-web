import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
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

// The account as the database has it now: its securityVersion, or gone.
const account = { current: { securityVersion: 0 } as { securityVersion: number } | null };
const findUnique = vi.fn(() => Promise.resolve(account.current));
const prisma = { user: { findUnique } } as unknown as PrismaService;
const guard = new JwtAuthGuard(jwt, prisma);

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
  account.current = { securityVersion: 0 };
});

describe('JwtAuthGuard', () => {
  it('puts the caller of a valid token on the request', async () => {
    const token = await jwt.signAsync({ sub: USER_ID, role: 'admin', sv: 0 });
    const { context, req } = contextWith(`Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({ id: USER_ID, role: 'admin' });
  });

  it('accepts the scheme in any case', async () => {
    const token = await jwt.signAsync({ sub: USER_ID, role: 'member', sv: 0 });
    await expect(guard.canActivate(contextWith(`bearer ${token}`).context)).resolves.toBe(true);
  });

  it('refuses a request without a bearer token', async () => {
    await expect(guard.canActivate(contextWith().context)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(contextWith('Basic abc').context)).rejects.toThrow(
      'Missing access token',
    );
  });

  it('refuses a token signed with another secret, or expired', async () => {
    const forged = await signer('x'.repeat(64)).signAsync({ sub: USER_ID, role: 'admin', sv: 0 });
    await expect(guard.canActivate(contextWith(`Bearer ${forged}`).context)).rejects.toThrow(
      'Invalid or expired access token',
    );
    const expired = await jwt.signAsync({ sub: USER_ID, role: 'admin', sv: 0 }, { expiresIn: -10 });
    await expect(guard.canActivate(contextWith(`Bearer ${expired}`).context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepts a token signed with the previous secret only while a rotation is in progress', async () => {
    const old = await signer(PREVIOUS).signAsync({ sub: USER_ID, role: 'member', sv: 0 });
    await expect(guard.canActivate(contextWith(`Bearer ${old}`).context)).rejects.toThrow(
      UnauthorizedException,
    );
    env.JWT_ACCESS_SECRET_PREVIOUS = PREVIOUS;
    await expect(guard.canActivate(contextWith(`Bearer ${old}`).context)).resolves.toBe(true);
  });

  it('refuses a token signed with another algorithm, even with the right secret', async () => {
    const other = await jwt.signAsync(
      { sub: USER_ID, role: 'admin', sv: 0 },
      { algorithm: 'HS512' },
    );
    await expect(guard.canActivate(contextWith(`Bearer ${other}`).context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a validly signed token whose claims are not ours', async () => {
    const odd = await jwt.signAsync({ sub: 'not-a-uuid', role: 'root', sv: 0 });
    await expect(guard.canActivate(contextWith(`Bearer ${odd}`).context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("refuses a token minted before the account's last credential change, at once", async () => {
    const token = await jwt.signAsync({ sub: USER_ID, role: 'member', sv: 0 });
    // A new password raised the account's securityVersion.
    account.current = { securityVersion: 1 };
    await expect(guard.canActivate(contextWith(`Bearer ${token}`).context)).rejects.toThrow(
      'Invalid or expired access token',
    );
    expect(findUnique).toHaveBeenLastCalledWith({
      where: { id: USER_ID },
      select: { securityVersion: true },
    });
  });

  it('refuses the token of an account that no longer exists', async () => {
    const token = await jwt.signAsync({ sub: USER_ID, role: 'member', sv: 0 });
    account.current = null;
    await expect(guard.canActivate(contextWith(`Bearer ${token}`).context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a token without sv (minted before it existed): the web app refreshes it', async () => {
    const token = await jwt.signAsync({ sub: USER_ID, role: 'member' });
    await expect(guard.canActivate(contextWith(`Bearer ${token}`).context)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

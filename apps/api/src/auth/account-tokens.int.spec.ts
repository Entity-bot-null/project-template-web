import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../test/app.js';
import { seedUser } from '../../test/auth.js';
import { AccountTokenSweep, hashAccountToken, newAccountToken } from './account-tokens.js';

// The hourly sweep of one-time links against PostgreSQL: what it deletes,
// and what it must leave alone.

const DAY = 86_400_000;
const hash = () => hashAccountToken(newAccountToken());

describe('AccountTokenSweep (PostgreSQL)', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await t.app.close();
  });

  it('deletes links used or expired a day ago, and sign-ups and invitations nobody can finish', async () => {
    const now = Date.now();
    const ada = await seedUser(t.prisma, { email: 'ada@example.test', role: 'admin' });
    const token = (overrides: Record<string, unknown>) =>
      t.prisma.accountToken.create({
        data: {
          userId: ada.id,
          purpose: 'password_reset',
          tokenHash: hash(),
          securityVersion: 0,
          email: ada.email,
          createdAt: new Date(now - 10 * DAY),
          expiresAt: new Date(now + DAY),
          ...overrides,
        },
      });
    const usedLongAgo = await token({ usedAt: new Date(now - 2 * DAY) });
    const expiredLongAgo = await token({ expiresAt: new Date(now - 2 * DAY) });
    const live = await token({});
    const expiredJustNow = await token({ expiresAt: new Date(now - 60_000) });

    const signUp = (email: string, overrides: Record<string, unknown>) =>
      t.prisma.signUp.create({ data: { email, name: 'X', passwordHash: 'h', ...overrides } });
    await signUp('expired@example.test', {
      tokenHash: hash(),
      expiresAt: new Date(now - 2 * DAY),
    });
    await signUp('never-sent@example.test', { createdAt: new Date(now - 3 * DAY) });
    const pendingSignUp = await signUp('pending@example.test', {
      tokenHash: hash(),
      expiresAt: new Date(now + DAY),
    });

    const invitation = (email: string, overrides: Record<string, unknown>) =>
      t.prisma.invitation.create({
        data: { email, role: 'member', invitedById: ada.id, ...overrides },
      });
    await invitation('expired-invite@example.test', {
      tokenHash: hash(),
      expiresAt: new Date(now - 2 * DAY),
    });
    await invitation('never-sent-invite@example.test', { createdAt: new Date(now - 3 * DAY) });
    const pendingInvitation = await invitation('pending-invite@example.test', {
      tokenHash: hash(),
      expiresAt: new Date(now + DAY),
    });

    await expect(t.app.get(AccountTokenSweep).sweep(now)).resolves.toBe(6);
    expect((await t.prisma.accountToken.findMany()).map((row) => row.id).sort()).toEqual(
      [live.id, expiredJustNow.id].sort(),
    );
    expect(usedLongAgo.id).not.toBe(expiredLongAgo.id);
    expect((await t.prisma.signUp.findMany()).map((row) => row.id)).toEqual([pendingSignUp.id]);
    expect((await t.prisma.invitation.findMany()).map((row) => row.id)).toEqual([
      pendingInvitation.id,
    ]);
  });
});

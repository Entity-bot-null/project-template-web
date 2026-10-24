import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../prisma/generated/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  AccountTokenSweep,
  consumeAccountToken,
  hashAccountToken,
  mintAccountToken,
  tokenOwner,
} from './account-tokens.js';

// The SQL runs against PostgreSQL in password-reset.int.spec.ts (concurrent
// use of one token, the lock); here, the decisions.

const NOW = Date.parse('2026-10-13T10:00:00Z');
const ACCOUNT = { id: 'u1', email: 'ada@example.test', securityVersion: 2 };
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  userId: 'u1',
  securityVersion: 2,
  email: 'ada@example.test',
  targetEmail: null,
  expiresAt: new Date(NOW + 60_000),
  ...overrides,
});

function txWith(rows: unknown[] = [row()], updated = 1) {
  const tx = {
    $queryRaw: vi.fn(() => Promise.resolve(rows)),
    accountToken: {
      deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
      create: vi.fn(() => Promise.resolve({})),
      updateMany: vi.fn(() => Promise.resolve({ count: updated })),
      findUnique: vi.fn(() => Promise.resolve({ userId: 'u1' })),
    },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}

describe('mintAccountToken', () => {
  it('mints 256 random bits, stores only their hash, and drops the earlier unused tokens of the kind', async () => {
    const { tx, client } = txWith();
    const token = await mintAccountToken(
      client,
      {
        userId: 'u1',
        purpose: 'password_reset',
        securityVersion: 2,
        email: 'ada@example.test',
        ttlMs: 30 * 60_000,
      },
      NOW,
    );
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The account's row first, like every flow that uses a token: no deadlock.
    const [lock] = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray];
    expect(lock.join('?')).toContain('FROM "users" WHERE "id" = ?::uuid FOR UPDATE');
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(tx.accountToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', purpose: 'password_reset', usedAt: null },
    });
    const [[{ data }]] = tx.accountToken.create.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ];
    expect(data).toEqual({
      userId: 'u1',
      purpose: 'password_reset',
      tokenHash: hashAccountToken(token),
      securityVersion: 2,
      email: 'ada@example.test',
      targetEmail: null,
      expiresAt: new Date(NOW + 30 * 60_000),
      createdAt: new Date(NOW),
    });
    expect(JSON.stringify(data)).not.toContain(token);
    // Never the same twice.
    expect(await mintAccountToken(client, { ...data, ttlMs: 1 } as never, NOW)).not.toBe(token);
  });
});

describe('mintAccountToken for a change of email', () => {
  it('records the target address, and keeps earlier revert links when asked to', async () => {
    const { tx, client } = txWith();
    await mintAccountToken(
      client,
      {
        userId: 'u1',
        purpose: 'email_revert',
        securityVersion: 3,
        email: 'new@example.test',
        targetEmail: 'ada@example.test',
        ttlMs: 7 * 86_400_000,
        replaceEarlier: false,
      },
      NOW,
    );
    // A later change must not void the link that undoes an earlier one.
    expect(tx.accountToken.deleteMany).not.toHaveBeenCalled();
    const [[{ data }]] = tx.accountToken.create.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ];
    expect(data).toMatchObject({ purpose: 'email_revert', targetEmail: 'ada@example.test' });
  });
});

describe('consumeAccountToken', () => {
  it('takes a working token for good, locking its row', async () => {
    const { tx, client } = txWith();
    await expect(
      consumeAccountToken(client, 'the-token', 'password_reset', ACCOUNT, NOW),
    ).resolves.toEqual({
      id: 't1',
      userId: 'u1',
      targetEmail: null,
      securityVersion: ACCOUNT.securityVersion,
    });
    const [sql, ...values] = tx.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(sql.join('?')).toContain('FOR UPDATE');
    expect(sql.join('?')).toContain('"used_at" IS NULL');
    expect(values).toEqual([hashAccountToken('the-token'), 'password_reset']);
    expect(tx.accountToken.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', usedAt: null },
      data: { usedAt: new Date(NOW) },
    });
  });

  it.each([
    ['unknown or already used', []],
    ['for another account', [row({ userId: 'u2' })]],
    ['expired', [row({ expiresAt: new Date(NOW) })]],
    ['minted before a credential change', [row({ securityVersion: 1 })]],
    ['sent to another address', [row({ email: 'old@example.test' })]],
  ])('refuses a token %s, without consuming anything', async (_case, rows) => {
    const { tx, client } = txWith(rows);
    await expect(
      consumeAccountToken(client, 'the-token', 'password_reset', ACCOUNT, NOW),
    ).resolves.toBeUndefined();
    expect(tx.accountToken.updateMany).not.toHaveBeenCalled();
  });

  it('takes a revert token whatever happened to the account since, never an expired one', async () => {
    const changed = { ...ACCOUNT, email: 'thief@example.test', securityVersion: 9 };
    // Its securityVersion, right after the change it undoes, ranks it.
    const { client } = txWith([row({ targetEmail: 'ada@example.test', securityVersion: 4 })]);
    await expect(
      consumeAccountToken(client, 'the-token', 'email_revert', changed, NOW, false),
    ).resolves.toEqual({
      id: 't1',
      userId: 'u1',
      targetEmail: 'ada@example.test',
      securityVersion: 4,
    });
    const expired = txWith([row({ expiresAt: new Date(NOW) })]);
    await expect(
      consumeAccountToken(expired.client, 'the-token', 'email_revert', changed, NOW, false),
    ).resolves.toBeUndefined();
    const other = txWith([row({ userId: 'u2' })]);
    await expect(
      consumeAccountToken(other.client, 'the-token', 'email_revert', changed, NOW, false),
    ).resolves.toBeUndefined();
  });

  it('refuses a token another request consumed in between', async () => {
    const { client } = txWith([row()], 0);
    await expect(
      consumeAccountToken(client, 'the-token', 'password_reset', ACCOUNT, NOW),
    ).resolves.toBeUndefined();
  });
});

describe('tokenOwner', () => {
  const stored = (overrides: Record<string, unknown> = {}) => ({
    userId: 'u1',
    purpose: 'password_reset',
    usedAt: null,
    expiresAt: new Date(NOW + 60_000),
    ...overrides,
  });

  it('names the account of a token that can still work, by its hash', async () => {
    const { tx, client } = txWith();
    tx.accountToken.findUnique.mockResolvedValueOnce(stored());
    await expect(tokenOwner(client, 'the-token', 'password_reset', NOW)).resolves.toBe('u1');
    expect(tx.accountToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashAccountToken('the-token') },
      select: { userId: true, purpose: true, usedAt: true, expiresAt: true },
    });
  });

  it.each([
    ['unknown', null],
    ['of another purpose', stored({ purpose: 'email_change' })],
    ['used', stored({ usedAt: new Date(NOW - 1) })],
    ['expired', stored({ expiresAt: new Date(NOW) })],
  ])('names nobody for a token %s', async (_case, found) => {
    const { tx, client } = txWith();
    tx.accountToken.findUnique.mockResolvedValueOnce(found as never);
    await expect(tokenOwner(client, 'the-token', 'password_reset', NOW)).resolves.toBeUndefined();
  });
});

describe('AccountTokenSweep', () => {
  let sweep: AccountTokenSweep;
  const deleteMany = vi.fn(() => Promise.resolve({ count: 3 }));
  const deleteSignUps = vi.fn(() => Promise.resolve({ count: 2 }));
  const deleteInvitations = vi.fn(() => Promise.resolve({ count: 1 }));

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    sweep = new AccountTokenSweep({
      accountToken: { deleteMany },
      signUp: { deleteMany: deleteSignUps },
      invitation: { deleteMany: deleteInvitations },
    } as unknown as PrismaService);
  });
  afterEach(() => {
    sweep.onModuleDestroy();
  });

  it('deletes tokens used or expired more than a day ago, at boot and then on a timer', async () => {
    await sweep.onModuleInit();
    expect(deleteMany).toHaveBeenCalledTimes(1);
    await expect(sweep.sweep(NOW)).resolves.toBe(6);
    const before = new Date(NOW - 86_400_000);
    expect(deleteMany).toHaveBeenLastCalledWith({
      where: { OR: [{ expiresAt: { lt: before } }, { usedAt: { lt: before } }] },
    });
  });

  it('deletes invitations whose link expired a day ago, or whose message never went out', async () => {
    await sweep.sweep(NOW);
    expect(deleteInvitations).toHaveBeenLastCalledWith({
      where: {
        OR: [
          { expiresAt: { lt: new Date(NOW - 86_400_000) } },
          { expiresAt: null, createdAt: { lt: new Date(NOW - 2 * 86_400_000) } },
        ],
      },
    });
  });

  it('deletes sign-ups whose link expired a day ago, or whose message never went out', async () => {
    await sweep.sweep(NOW);
    expect(deleteSignUps).toHaveBeenLastCalledWith({
      where: {
        OR: [
          { expiresAt: { lt: new Date(NOW - 86_400_000) } },
          // Queue validity (24 hours) and a day.
          { expiresAt: null, createdAt: { lt: new Date(NOW - 2 * 86_400_000) } },
        ],
      },
    });
  });

  it('logs a failed sweep and carries on', async () => {
    deleteMany.mockRejectedValueOnce(new Error('database down'));
    await expect(sweep.sweep(NOW)).resolves.toBe(0);
  });
});

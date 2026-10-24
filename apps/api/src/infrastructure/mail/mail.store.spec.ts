import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { MailStore } from './mail.store.js';
import { MAIL_TEMPLATE_REGISTRY } from './templates/registry.js';
import type { ClaimedMessage } from './mail.types.js';

// The SQL itself runs against PostgreSQL in mail-outbox.int.spec.ts (claims
// racing, leases running out, retention); here, what each method asks for.

const claimed: ClaimedMessage = {
  id: 'm1',
  kind: 'test',
  recipient: 'ada@example.test',
  userId: null,
  payload: {},
  attempts: 2,
  claimId: '7c1e5a0b-3d2f-4b6a-9e8c-1f0d2a3b4c5d',
  expiresAt: new Date('2026-10-13T12:00:00Z'),
  createdAt: new Date('2026-10-13T11:00:00Z'),
  requestId: null,
};

function storeWith(overrides: Record<string, unknown> = {}) {
  const prisma = {
    $queryRaw: vi.fn(() => Promise.resolve([claimed])),
    $transaction: vi.fn((work: (tx: unknown) => Promise<unknown>) => work('tx')),
    mailMessage: {
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      deleteMany: vi.fn(() => Promise.resolve({ count: 3 })),
      aggregate: vi.fn(() =>
        Promise.resolve({ _count: { _all: 0 }, _min: { createdAt: null as Date | null } }),
      ),
    },
    ...overrides,
  };
  return {
    prisma,
    store: new MailStore(prisma as unknown as PrismaService, MAIL_TEMPLATE_REGISTRY),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MailStore', () => {
  it('claims one message in a single statement that skips the rows another worker is taking', async () => {
    const { prisma, store } = storeWith();
    await expect(store.claim(90_000)).resolves.toEqual(claimed);
    const [sql, lease] = prisma.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      number,
    ];
    const statement = sql.join('?');
    expect(statement).toContain('FOR UPDATE SKIP LOCKED');
    expect(statement).toContain('LIMIT 1');
    expect(statement).toContain('"attempts" = "attempts" + 1');
    // A new id for each claim: it fences what this worker records.
    expect(statement).toContain('"claim_id" = gen_random_uuid()');
    expect(statement).toContain('"claim_id" AS "claimId"');
    expect(statement).toContain(`("status" = 'sending' AND "locked_until" < now())`);
    expect(lease).toBe(90);
    // Security notices (the kinds nobody can request) are claimed first.
    expect(statement).toContain('ORDER BY ("kind"::text = ANY(?::text[])) DESC, "next_attempt_at"');
    const [, , urgent] = prisma.$queryRaw.mock.calls[0] as unknown as [unknown, unknown, string[]];
    expect(urgent).toEqual(
      Object.entries(MAIL_TEMPLATE_REGISTRY)
        .filter(([, template]) => !template.limited)
        .map(([kind]) => kind),
    );
    expect(urgent).toContain('password_changed');
    expect(urgent).not.toContain('password_reset');
  });

  it('answers undefined when nothing is due', async () => {
    const { store } = storeWith({ $queryRaw: vi.fn(() => Promise.resolve([])) });
    await expect(store.claim()).resolves.toBeUndefined();
  });

  it('fences every outcome by the claim: only the same attempt and claim id, still sending, can finish it', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-13T11:30:00Z') });
    const { prisma, store } = storeWith();
    await store.markSent(claimed);
    await store.reschedule(claimed, 60_000, 'smtp_4xx_451');
    await store.markFailed(claimed, 'smtp_5xx_550');
    await store.markExpired(claimed, 'expired');
    const calls = prisma.mailMessage.updateMany.mock.calls as unknown as {
      where: unknown;
      data: Record<string, unknown>;
    }[][];
    for (const [call] of calls) {
      expect(call?.where).toEqual({
        id: 'm1',
        status: 'sending',
        attempts: 2,
        claimId: claimed.claimId,
      });
    }
    const [sent, rescheduled, failed, expired] = calls.map(([call]) => call?.data);
    expect(sent).toMatchObject({ status: 'sent', recipient: null, lockedUntil: null });
    expect(rescheduled).toEqual({
      status: 'pending',
      nextAttemptAt: new Date('2026-10-13T11:31:00Z'),
      lockedUntil: null,
      lastError: 'smtp_4xx_451',
    });
    // A failed message keeps its address for a manual retry; an expired one does not.
    expect(failed).toEqual({ status: 'failed', lockedUntil: null, lastError: 'smtp_5xx_550' });
    expect(expired).toMatchObject({ status: 'expired', recipient: null });
  });

  it('renews the lease of a message still being sent, fenced by its claim, by the database clock', async () => {
    const executeRaw = vi.fn(() => Promise.resolve(1));
    const { store } = storeWith({ $executeRaw: executeRaw });
    await expect(store.renewLease(claimed, 90_000)).resolves.toBe(true);
    const [sql, lease, id, attempts, claimId] = executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      number,
      string,
      number,
      string,
    ];
    const statement = sql.join('?');
    expect(statement).toContain('"locked_until" = now() + make_interval');
    expect(statement).toMatch(
      /"status" = 'sending' AND "attempts" = \?\s+AND "claim_id" = \?::uuid/,
    );
    expect([lease, id, attempts, claimId]).toEqual([90, 'm1', 2, claimed.claimId]);
    // Taken over by another worker meanwhile: no longer this one's.
    executeRaw.mockResolvedValueOnce(0);
    await expect(store.renewLease(claimed)).resolves.toBe(false);
  });

  it('reports whether the fenced update found its claim', async () => {
    const { store } = storeWith({
      mailMessage: { updateMany: vi.fn(() => Promise.resolve({ count: 0 })) },
    });
    await expect(store.markSent(claimed)).resolves.toBe(false);
  });

  it('tells what became of a message whose claim refused a transition', async () => {
    const findUnique = vi.fn();
    const { store } = storeWith({ mailMessage: { findUnique } });
    const claimId = claimed.claimId;
    const claim = { id: 'm1', attempts: 2, claimId };
    // Dropped under this claim by an undo that left it to this worker.
    findUnique.mockResolvedValueOnce({
      status: 'expired',
      attempts: 2,
      claimId,
      lastError: 'superseded:held',
    });
    await expect(store.fateOf(claim)).resolves.toBe('dropped');
    // Dropped under it, counted by the undo (its lease had run out).
    findUnique.mockResolvedValueOnce({
      status: 'expired',
      attempts: 2,
      claimId,
      lastError: 'superseded',
    });
    await expect(store.fateOf(claim)).resolves.toBe('counted');
    // A later attempt: another worker's claim, whatever became of it.
    findUnique.mockResolvedValueOnce({
      status: 'expired',
      attempts: 3,
      claimId,
      lastError: 'superseded:held',
    });
    await expect(store.fateOf(claim)).resolves.toBe('taken-over');
    findUnique.mockResolvedValueOnce({ status: 'sending', attempts: 3, claimId, lastError: null });
    await expect(store.fateOf(claim)).resolves.toBe('taken-over');
    // The same attempt number under another claim: a retry by hand started
    // the attempts again since.
    findUnique.mockResolvedValueOnce({
      status: 'expired',
      attempts: 2,
      claimId: '0b9f8e7d-6c5b-4a39-8281-7f6e5d4c3b2a',
      lastError: 'superseded:held',
    });
    await expect(store.fateOf(claim)).resolves.toBe('taken-over');
    // Deleted with its account.
    findUnique.mockResolvedValueOnce(null);
    await expect(store.fateOf(claim)).resolves.toBe('gone');
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'm1' },
      select: { status: true, attempts: true, claimId: true, lastError: true },
    });
  });

  it('runs template work in a short READ COMMITTED transaction, whatever the default', async () => {
    const { prisma, store } = storeWith();
    await expect(store.inTransaction((tx) => Promise.resolve(tx))).resolves.toBe('tx');
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 10_000,
      isolationLevel: 'ReadCommitted',
    });
  });

  it("counts the messages still to send and the oldest one's age", async () => {
    vi.useFakeTimers({ now: new Date('2026-10-13T11:10:00Z') });
    const { store } = storeWith({
      mailMessage: {
        aggregate: vi.fn(() =>
          Promise.resolve({
            _count: { _all: 4 },
            _min: { createdAt: new Date('2026-10-13T11:00:00Z') },
          }),
        ),
      },
    });
    await expect(store.stats()).resolves.toEqual({ waiting: 4, oldestAgeSeconds: 600 });
    const empty = storeWith().store;
    await expect(empty.stats()).resolves.toEqual({ waiting: 0, oldestAgeSeconds: 0 });
  });

  it('deletes finished rows after 30 days and clears failed addresses after 7', async () => {
    const now = Date.parse('2026-10-31T00:00:00Z');
    const { prisma, store } = storeWith();
    await expect(store.sweep(now)).resolves.toEqual({ deleted: 3, cleared: 1, expired: 1 });
    // Pending ones a day past their validity (email turned off since): dropped.
    expect(prisma.mailMessage.updateMany).toHaveBeenCalledWith({
      where: { status: 'pending', expiresAt: { lt: new Date('2026-10-30T00:00:00Z') } },
      data: { status: 'expired', recipient: null },
    });
    expect(prisma.mailMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['sent', 'expired', 'failed'] },
        createdAt: { lt: new Date('2026-10-01T00:00:00Z') },
      },
    });
    expect(prisma.mailMessage.updateMany).toHaveBeenCalledWith({
      where: {
        status: 'failed',
        recipient: { not: null },
        updatedAt: { lt: new Date('2026-10-24T00:00:00Z') },
      },
      data: { recipient: null },
    });
  });

  it('puts failed messages that still have an address back in the queue, each with its kind validity', async () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    const kinds = Object.keys(MAIL_TEMPLATE_REGISTRY);
    const id = '0d5f6c2a-9b7e-4c1d-8a3f-2e6b9c4d7a10';
    const $executeRaw = vi.fn((_sql: TemplateStringsArray, ...values: unknown[]) =>
      Promise.resolve(values.includes('password_reset') ? 1 : 0),
    );
    const { store } = storeWith({ $executeRaw });
    await expect(store.retryFailed({ id }, now)).resolves.toBe(1);
    expect($executeRaw).toHaveBeenCalledTimes(kinds.length);
    const calls = $executeRaw.mock.calls as unknown as [TemplateStringsArray, ...unknown[]][];
    const [sql, ...values] = calls.find((call) => call.includes('password_reset')) ?? [];
    const statement = sql?.join('?') ?? '';
    // The attempts start again, as in the previous release, whose workers
    // count them: the claim id, not the attempt alone, fences each claim, and
    // it is cleared (the previous release's claims leave it as it is).
    expect(statement).toContain(`SET "status" = 'pending', "attempts" = 0, "claim_id" = NULL,`);
    expect(statement).toContain(`"status" = 'failed' AND "recipient" IS NOT NULL`);
    // Locked in id order, like expireQueued.
    expect(statement).toContain('ORDER BY "id"');
    expect(statement).toContain('FOR UPDATE');
    // A new validity per kind: an outage longer than it no longer drops them unsent.
    expect(values).toEqual([
      new Date(now),
      new Date(now + MAIL_TEMPLATE_REGISTRY.password_reset.ttlMs),
      'password_reset',
      id,
      id,
    ]);

    $executeRaw.mockClear();
    await expect(store.retryFailed({ kind: 'test' }, now)).resolves.toBe(0);
    expect($executeRaw).toHaveBeenCalledTimes(1);
    expect(($executeRaw.mock.calls[0] as unknown[]).slice(1)).toContain(null);
    // Not a message's id (a typo on the command line): nothing is touched.
    $executeRaw.mockClear();
    await expect(store.retryFailed({ id: 'not-an-id' }, now)).resolves.toBe(0);
    expect($executeRaw).not.toHaveBeenCalled();
  });
});

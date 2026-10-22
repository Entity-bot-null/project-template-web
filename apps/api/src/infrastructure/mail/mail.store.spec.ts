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

  it('fences every outcome by the claim: only the same attempt, still sending, can finish it', async () => {
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
      expect(call?.where).toEqual({ id: 'm1', status: 'sending', attempts: 2 });
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
    const [sql, lease, id, attempts] = executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      number,
      string,
      number,
    ];
    const statement = sql.join('?');
    expect(statement).toContain('"locked_until" = now() + make_interval');
    expect(statement).toContain(`"status" = 'sending' AND "attempts" = ?`);
    expect([lease, id, attempts]).toEqual([90, 'm1', 2]);
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

  it('runs template work in a short transaction', async () => {
    const { prisma, store } = storeWith();
    await expect(store.inTransaction((tx) => Promise.resolve(tx))).resolves.toBe('tx');
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 10_000 });
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
    const { prisma, store } = storeWith({
      mailMessage: {
        updateMany: vi.fn(({ where }: { where: { id?: string; kind: string } }) =>
          Promise.resolve({ count: where.kind === 'password_reset' ? 1 : 0 }),
        ),
      },
    });
    await expect(store.retryFailed({ id: 'm1' }, now)).resolves.toBe(1);
    const calls = prisma.mailMessage.updateMany.mock.calls as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ][];
    expect(calls.map(([call]) => call.where)).toEqual(
      kinds.map((kind) => ({ status: 'failed', recipient: { not: null }, kind, id: 'm1' })),
    );
    // A new validity per kind: an outage longer than it no longer drops them unsent.
    const reset = calls.find(([call]) => call.where.kind === 'password_reset')?.[0];
    expect(reset?.data).toEqual({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(now),
      expiresAt: new Date(now + MAIL_TEMPLATE_REGISTRY.password_reset.ttlMs),
      lastError: null,
    });

    prisma.mailMessage.updateMany.mockClear();
    await expect(store.retryFailed({ kind: 'test' }, now)).resolves.toBe(0);
    const onlyTest = prisma.mailMessage.updateMany.mock.calls as unknown as [
      { where: Record<string, unknown> },
    ][];
    expect(onlyTest.map(([call]) => call.where)).toEqual([
      { status: 'failed', recipient: { not: null }, kind: 'test' },
    ]);
  });
});

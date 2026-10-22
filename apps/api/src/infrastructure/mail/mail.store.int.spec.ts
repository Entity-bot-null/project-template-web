import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../../test/app.js';
import { MailOutboxService } from './mail-outbox.service.js';
import { MailStore } from './mail.store.js';

// The outbox's lease renewal on PostgreSQL (mail.store.spec.ts reads its SQL
// only): a worker still sending extends its own claim, never another's.

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase(t.prisma);
});
afterAll(async () => {
  await t.app.close();
});

it('renews the lease of a message still being sent, fenced by its claim', async () => {
  const store = t.app.get(MailStore);
  await t.prisma.mailMessage.create({
    data: {
      kind: 'test',
      recipient: 'lease@example.test',
      recipientHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  const claimed = await store.claim(5_000);
  expect(claimed).toBeDefined();
  if (claimed === undefined) return;

  await expect(store.renewLease(claimed, 600_000)).resolves.toBe(true);
  const row = await t.prisma.mailMessage.findUniqueOrThrow({ where: { id: claimed.id } });
  expect(row.lockedUntil?.getTime() ?? 0).toBeGreaterThan(Date.now() + 500_000);
  // Another attempt's claim (a worker that took it over): not this one's.
  await expect(store.renewLease({ ...claimed, attempts: claimed.attempts + 1 })).resolves.toBe(
    false,
  );
});

it("drops an account's waiting notices of a later change, counting those no worker holds", async () => {
  const user = await t.prisma.user.create({
    data: { email: 'outbox@example.test', name: 'Outbox', passwordHash: 'x' },
  });
  const notice = (
    status: 'pending' | 'sending' | 'failed',
    securityVersion: string,
    lockedUntil?: Date,
  ) =>
    t.prisma.mailMessage.create({
      data: {
        kind: 'email_changed',
        recipient: 'previous@example.test',
        recipientHash: 'b'.repeat(64),
        userId: user.id,
        payload: { changedAt: new Date().toISOString(), securityVersion },
        status,
        attempts: status === 'sending' ? 1 : 0,
        lockedUntil: lockedUntil ?? null,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
      select: { id: true },
    });
  const pending = await notice('pending', '5');
  const held = await notice('sending', '6', new Date(Date.now() + 60_000));
  const abandoned = await notice('sending', '6', new Date(Date.now() - 60_000));
  const failed = await notice('failed', '7');
  const earlier = await notice('pending', '3');

  const outcome = await t.prisma.$transaction((tx) =>
    t.app.get(MailOutboxService).expireQueued(tx, {
      kind: 'email_changed',
      userId: user.id,
      key: 'securityVersion',
      from: 5,
      reason: 'superseded',
    }),
  );
  // The one a worker holds under a live lease is that worker's to count.
  expect(outcome).toEqual({ dropped: 4, unclaimed: 3 });
  const rows = await t.prisma.mailMessage.findMany({
    where: { id: { in: [pending.id, held.id, abandoned.id, failed.id, earlier.id] } },
    select: { id: true, status: true, recipient: true },
  });
  const statusOf = (id: string) => rows.find((row) => row.id === id);
  for (const { id } of [pending, held, abandoned, failed]) {
    expect(statusOf(id)).toEqual({ id, status: 'expired', recipient: null });
  }
  // An earlier change's notice is kept.
  expect(statusOf(earlier.id)?.status).toBe('pending');
  // The worker holding it under a live lease counts it; the undo counted the
  // one whose lease had run out, whose worker may still be alive.
  const store = t.app.get(MailStore);
  await expect(store.fateOf({ id: held.id, attempts: 1 })).resolves.toBe('dropped');
  await expect(store.fateOf({ id: abandoned.id, attempts: 1 })).resolves.toBe('counted');
  await expect(store.fateOf({ id: held.id, attempts: 2 })).resolves.toBe('taken-over');
});

it('puts a failed message back with its attempts counted from the retry, never lowering them', async () => {
  // Alone in the outbox: the claim below takes the due message.
  await resetDatabase(t.prisma);
  const row = await t.prisma.mailMessage.create({
    data: {
      kind: 'test',
      recipient: 'retry@example.test',
      recipientHash: 'e'.repeat(64),
      status: 'failed',
      attempts: 3,
      lastError: 'connection',
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
  const store = t.app.get(MailStore);
  await expect(store.retryFailed({ id: row.id })).resolves.toBe(1);
  const back = await t.prisma.mailMessage.findUniqueOrThrow({ where: { id: row.id } });
  expect(back).toMatchObject({ status: 'pending', attempts: 3, attemptsBase: 3, lastError: null });
  expect(back.expiresAt.getTime()).toBeGreaterThan(Date.now());
  // A stale worker still holding attempt 1, 2 or 3 never matches the next claim (4).
  const claimed = await store.claim();
  expect(claimed).toMatchObject({ id: row.id, attempts: 4, attemptsBase: 3 });
  await expect(store.markSent({ id: row.id, attempts: 1 })).resolves.toBe(false);
  await expect(store.retryFailed({ id: 'not-an-id' })).resolves.toBe(0);
});

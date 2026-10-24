import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../../test/app.js';
import { MailOutboxService } from './mail-outbox.service.js';
import { MailStore } from './mail.store.js';

// The outbox's lease renewal on PostgreSQL (mail.store.spec.ts reads its SQL
// only): a worker still sending extends its own claim, never another's.

// The claim ids of rows the tests create as being sent, and of a claim they never made.
const CLAIM = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';
const OTHER_CLAIM = '0b9f8e7d-6c5b-4a39-8281-7f6e5d4c3b2a';

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
  // The same attempt number under another claim (a retry by hand since): not this one's either.
  await expect(store.renewLease({ ...claimed, claimId: OTHER_CLAIM })).resolves.toBe(false);
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
        claimId: status === 'sending' ? CLAIM : null,
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
  const claim = { attempts: 1, claimId: CLAIM };
  await expect(store.fateOf({ id: held.id, ...claim })).resolves.toBe('dropped');
  await expect(store.fateOf({ id: abandoned.id, ...claim })).resolves.toBe('counted');
  await expect(store.fateOf({ id: held.id, ...claim, attempts: 2 })).resolves.toBe('taken-over');
  await expect(store.fateOf({ id: held.id, ...claim, claimId: OTHER_CLAIM })).resolves.toBe(
    'taken-over',
  );
});

it('judges a lease by the clock of the statement that drops the notice, not of its transaction', async () => {
  const user = await t.prisma.user.create({
    data: { email: 'lease-clock@example.test', name: 'Lease clock', passwordHash: 'x' },
  });
  const { id } = await t.prisma.mailMessage.create({
    data: {
      kind: 'email_changed',
      recipient: 'previous@example.test',
      recipientHash: 'f'.repeat(64),
      userId: user.id,
      payload: { securityVersion: '9' },
      status: 'sending',
      attempts: 1,
      claimId: CLAIM,
      lockedUntil: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
    select: { id: true },
  });
  // A lease that ends by the database's clock while the undo below waits
  // (for the account's lock, say) after its transaction began.
  await t.prisma.$executeRaw`
    UPDATE "mail_messages" SET "locked_until" = now() + interval '300 milliseconds'
    WHERE "id" = ${id}::uuid`;
  const outcome = await t.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1`;
    await new Promise((resolve) => setTimeout(resolve, 600));
    return t.app.get(MailOutboxService).expireQueued(tx, {
      kind: 'email_changed',
      userId: user.id,
      key: 'securityVersion',
      from: 9,
      reason: 'superseded',
    });
  });
  // No live worker holds it any more: the undo counts it.
  expect(outcome).toEqual({ dropped: 1, unclaimed: 1 });
  await expect(t.app.get(MailStore).fateOf({ id, attempts: 1, claimId: CLAIM })).resolves.toBe(
    'counted',
  );
});

it('puts a failed message back with its attempts started again, out of reach of its old claims', async () => {
  // Alone in the outbox: the claim below takes the due message.
  await resetDatabase(t.prisma);
  const row = await t.prisma.mailMessage.create({
    data: {
      kind: 'test',
      recipient: 'retry@example.test',
      recipientHash: 'e'.repeat(64),
      status: 'failed',
      attempts: 3,
      claimId: CLAIM,
      lastError: 'connection',
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
  const store = t.app.get(MailStore);
  await expect(store.retryFailed({ id: row.id })).resolves.toBe(1);
  const back = await t.prisma.mailMessage.findUniqueOrThrow({ where: { id: row.id } });
  // As the previous release does: its workers count the attempts.
  expect(back).toMatchObject({ status: 'pending', attempts: 0, claimId: null, lastError: null });
  expect(back.expiresAt.getTime()).toBeGreaterThan(Date.now());
  // The next claim is attempt 1 again, under a new id: a stale worker still
  // holding an old claim of the same number never matches it.
  const claimed = await store.claim();
  expect(claimed).toMatchObject({ id: row.id, attempts: 1 });
  expect(claimed?.claimId).not.toBe(CLAIM);
  await expect(store.markSent({ id: row.id, attempts: 1, claimId: CLAIM })).resolves.toBe(false);
  if (claimed !== undefined) await expect(store.markSent(claimed)).resolves.toBe(true);
  await expect(store.retryFailed({ id: 'not-an-id' })).resolves.toBe(0);
});

// The previous release's claim, as origin/main writes it during a deployment
// or after a rollback: the attempt goes up, the claim id stays as it is.
async function previousReleaseClaim(): Promise<{ id: string; attempts: number }> {
  const rows = await t.prisma.$queryRaw<{ id: string; attempts: number }[]>`
    UPDATE "mail_messages"
    SET "status" = 'sending', "attempts" = "attempts" + 1,
        "locked_until" = now() + interval '2 minutes', "updated_at" = now()
    WHERE "id" = (
      SELECT "id" FROM "mail_messages"
      WHERE ("status" = 'pending' AND "next_attempt_at" <= now())
         OR ("status" = 'sending' AND "locked_until" < now())
      ORDER BY "next_attempt_at", "id"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "attempts"`;
  const row = rows[0];
  if (row === undefined) throw new Error('The previous release claimed nothing');
  return row;
}

it("keeps a stalled claim dead after a retry by hand, when the previous release's workers take the message", async () => {
  await resetDatabase(t.prisma);
  const store = t.app.get(MailStore);
  await t.prisma.mailMessage.create({
    data: {
      kind: 'test',
      recipient: 'mixed@example.test',
      recipientHash: 'c'.repeat(64),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  // A worker of this release claims it, then stalls past its lease.
  const stalled = await store.claim(5_000);
  expect(stalled).toBeDefined();
  if (stalled === undefined) return;
  await t.prisma.mailMessage.update({
    where: { id: stalled.id },
    data: { lockedUntil: new Date(Date.now() - 1_000) },
  });
  // A worker of the previous release takes it over and gives up on it, fenced
  // by the attempt alone; the operator retries it by hand; a worker of the
  // previous release claims it again, at the stalled claim's attempt number.
  const taken = await previousReleaseClaim();
  await t.prisma.mailMessage.updateMany({
    where: { id: taken.id, status: 'sending', attempts: taken.attempts },
    data: { status: 'failed', lockedUntil: null, lastError: 'smtp_5xx_550' },
  });
  await expect(store.retryFailed({ id: stalled.id })).resolves.toBe(1);
  await expect(previousReleaseClaim()).resolves.toEqual({
    id: stalled.id,
    attempts: stalled.attempts,
  });
  // The stalled worker wakes up: the message is the other worker's.
  await expect(store.markSent(stalled)).resolves.toBe(false);
  await expect(store.renewLease(stalled)).resolves.toBe(false);
});

import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../../../test/app.js';
import { seedUser } from '../../../../test/auth.js';
import { lockUser } from '../../../auth/sessions.service.js';
import { MailOutboxService } from '../mail-outbox.service.js';
import type { ClaimedMessage } from '../mail.types.js';
import { emailChangedTemplate } from './email-changed.template.js';

// The notice of a change of email against PostgreSQL, where it matters: an
// undo that commits while the notice waits for the account's lock drops it,
// and the template sees that once the lock is granted (READ COMMITTED).

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase(t.prisma);
});
afterAll(async () => {
  await t.app.close();
});

it('mints no undo link for a notice an undo dropped while it waited for the lock', async () => {
  const user = await seedUser(t.prisma, { email: 'grace.moved@example.test', name: 'Grace' });
  const row = await t.prisma.mailMessage.create({
    data: {
      kind: 'email_changed',
      recipient: 'grace@example.test',
      recipientHash: 'b'.repeat(64),
      userId: user.id,
      payload: { changedAt: new Date().toISOString(), securityVersion: '1' },
      status: 'sending',
      attempts: 1,
      lockedUntil: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  const claimed: ClaimedMessage = {
    id: row.id,
    kind: row.kind,
    recipient: 'grace@example.test',
    userId: user.id,
    payload: row.payload,
    attempts: row.attempts,
    attemptsBase: row.attemptsBase,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    requestId: null,
  };

  // The undo: holds the account's lock, drops the notice, commits when told.
  let held!: () => void;
  const locked = new Promise<void>((resolve) => (held = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const undo = t.prisma.$transaction(async (tx) => {
    await lockUser(tx, user.id);
    await t.app.get(MailOutboxService).expireQueued(tx, {
      kind: 'email_changed',
      userId: user.id,
      key: 'securityVersion',
      from: 1,
      reason: 'superseded',
    });
    held();
    await released;
  });
  await locked;
  const composed = t.prisma.$transaction((tx) =>
    emailChangedTemplate.compose({
      tx,
      message: claimed,
      product: 'Integration',
      appUrl: 'https://app.example.test',
    }),
  );
  // The notice is waiting for the lock now; the undo commits.
  await new Promise((resolve) => setTimeout(resolve, 200));
  release();
  await undo;

  await expect(composed).resolves.toBeNull();
  expect(await t.prisma.accountToken.count({ where: { userId: user.id } })).toBe(0);
});

it("refuses a previous release's notice once that release undid the change after it was queued", async () => {
  // Under the previous release: the thief moved the account to B, then to C;
  // the owner then undid the first change (back at A, the account's
  // securityVersion raised) with a link that release left used. The notice
  // of the thief's second change, to B, was still in the outbox (failed, then
  // put back by hand after the upgrade).
  const owner = await seedUser(t.prisma, { email: 'owner.back@example.test', name: 'Owner' });
  await t.prisma.user.update({ where: { id: owner.id }, data: { securityVersion: 3 } });
  const queuedAt = new Date(Date.now() - 60 * 60_000);
  const undo = (usedAt: Date) =>
    t.prisma.accountToken.create({
      data: {
        userId: owner.id,
        purpose: 'email_revert',
        tokenHash: (usedAt < queuedAt ? 'a' : 'e').repeat(64),
        securityVersion: 1,
        email: 'thief.b@example.test',
        targetEmail: 'owner.back@example.test',
        createdAt: new Date(usedAt.getTime() - 60_000),
        usedAt,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });
  const legacyNotice = async () => {
    const row = await t.prisma.mailMessage.create({
      data: {
        kind: 'email_changed',
        recipient: 'thief.b@example.test',
        recipientHash: 'f'.repeat(64),
        userId: owner.id,
        payload: { changedAt: queuedAt.toISOString() },
        status: 'sending',
        attempts: 1,
        lockedUntil: new Date(Date.now() + 60_000),
        expiresAt: new Date(Date.now() + 60 * 60_000),
        createdAt: queuedAt,
      },
    });
    const claimed: ClaimedMessage = {
      id: row.id,
      kind: row.kind,
      recipient: 'thief.b@example.test',
      userId: owner.id,
      payload: row.payload,
      attempts: 1,
      attemptsBase: 0,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      requestId: null,
    };
    return t.prisma.$transaction((tx) =>
      emailChangedTemplate.compose({
        tx,
        message: claimed,
        product: 'Integration',
        appUrl: 'https://app.example.test',
      }),
    );
  };
  const unused = () =>
    t.prisma.accountToken.count({
      where: { userId: owner.id, purpose: 'email_revert', usedAt: null },
    });

  // An undo used before the notice was queued is history: the notice goes out.
  const before = await undo(new Date(queuedAt.getTime() - 60 * 60_000));
  await expect(legacyNotice()).resolves.not.toBeNull();
  await t.prisma.accountToken.deleteMany({ where: { userId: owner.id, NOT: { id: before.id } } });

  // Used after it: the change is undone, no link the thief could use.
  await undo(new Date(Date.now() - 60_000));
  await expect(legacyNotice()).resolves.toBeNull();
  await expect(unused()).resolves.toBe(0);
});

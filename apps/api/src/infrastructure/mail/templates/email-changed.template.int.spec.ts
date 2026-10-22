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

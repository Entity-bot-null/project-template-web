import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../../test/app.js';
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

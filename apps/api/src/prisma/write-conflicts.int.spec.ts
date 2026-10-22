import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../test/app.js';
import type { Prisma } from './generated/client.js';
import { isWriteConflict } from './write-conflicts.js';

// What PostgreSQL's deadlock reaches the application as, through the pg
// adapter: a raw statement's (expireQueued) and a model query's. The undo of
// a change of email retries on both (onceMoreOnWriteConflict); an upgrade of
// Prisma that changed either shape fails here.

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase(t.prisma);
});
afterAll(async () => {
  await t.app.close();
});

async function twoRows(): Promise<[string, string]> {
  const rows = await Promise.all(
    ['c', 'd'].map((letter) =>
      t.prisma.mailMessage.create({
        data: {
          kind: 'test',
          recipient: `${letter}@example.test`,
          recipientHash: letter.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
        select: { id: true },
      }),
    ),
  );
  return [rows[0]?.id ?? '', rows[1]?.id ?? ''];
}

/** Two transactions that each update one row, then the other's: one of them deadlocks. */
async function deadlock(
  update: (tx: Prisma.TransactionClient, id: string) => Promise<unknown>,
): Promise<unknown> {
  const [a, b] = await twoRows();
  let first = 0;
  let release!: () => void;
  const bothFirst = new Promise<void>((resolve) => (release = resolve));
  const run = (one: string, other: string) =>
    t.prisma.$transaction(
      async (tx) => {
        await update(tx, one);
        first += 1;
        if (first === 2) release();
        await bothFirst;
        await update(tx, other);
      },
      { timeout: 10_000 },
    );
  const settled = await Promise.allSettled([run(a, b), run(b, a)]);
  const failed = settled.find((result) => result.status === 'rejected');
  return failed?.reason;
}

it('reports a deadlock in a raw statement as a write conflict (P2010)', async () => {
  const error = await deadlock(
    (tx, id) =>
      tx.$executeRaw`UPDATE "mail_messages" SET "updated_at" = now() WHERE "id" = ${id}::uuid`,
  );
  expect(error).toMatchObject({ code: 'P2010' });
  expect(isWriteConflict(error)).toBe(true);
});

it('reports a deadlock in a model query as a write conflict (P2034)', async () => {
  const error = await deadlock((tx, id) =>
    tx.mailMessage.updateMany({ where: { id }, data: { lastError: 'touched' } }),
  );
  expect(error).toMatchObject({ code: 'P2034' });
  expect(isWriteConflict(error)).toBe(true);
});

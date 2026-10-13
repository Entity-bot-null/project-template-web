import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../../test/app.js';
import { envelopeOf } from '../../../test/http.js';
import {
  deleteMessagesTo,
  disarmChaos,
  failRecipients,
  mailTestOptions,
  messagesTo,
  readMessage,
  skipWithoutMailpit,
  testAddress,
  UNREACHABLE_SMTP_URL,
} from '../../../test/mailpit.js';
import type { MailOptions } from './mail.types.js';
import { MailOutboxService } from './mail-outbox.service.js';
import { MailWorker } from './mail-worker.service.js';
import { MAIL_OPTIONS, MAIL_TEMPLATES } from './mail.constants.js';
import { recipientHash } from './mail.recipient.js';
import { MailStore } from './mail.store.js';
import { MAIL_TEMPLATE_REGISTRY } from './templates/registry.js';
import { testTemplate } from './templates/test.template.js';

// The outbox against the real database and a real SMTP server (Mailpit):
// what the unit specs fake. Each app here is one API instance; several apps
// on the one database are several instances sharing the queue. Workers only
// deliver when a spec says so (runOnce): their own wake-ups (the poll, a
// commit) are switched off, so a spec can change a row before it is sent.
// The last spec checks those wake-ups on a worker left alone.

interface Instance extends TestApp {
  outbox: MailOutboxService;
  worker: MailWorker;
  store: MailStore;
}

async function instance(
  overrides: Partial<MailOptions> = {},
  templates = MAIL_TEMPLATE_REGISTRY,
  { automatic = false } = {},
): Promise<Instance> {
  const t = await createTestApp((builder) =>
    builder
      .overrideProvider(MAIL_OPTIONS)
      .useValue(mailTestOptions(overrides))
      .overrideProvider(MAIL_TEMPLATES)
      .useValue(templates),
  );
  const worker = t.app.get(MailWorker);
  if (!automatic) manual(worker);
  return { ...t, outbox: t.app.get(MailOutboxService), worker, store: t.app.get(MailStore) };
}

/** Switches off the worker's own wake-ups (spies are restored after each spec). */
function manual(worker: MailWorker): void {
  vi.spyOn(worker, 'wake').mockImplementation(() => undefined);
}

/** Queues a test message in a transaction of its own, the way a feature does. */
async function queue(i: Instance, to: string, extra: { dedupeKey?: string } = {}) {
  const result = await i.prisma.$transaction((tx) =>
    i.outbox.enqueue(tx, { kind: 'test', to, ...extra }),
  );
  i.outbox.notifyQueued();
  return result;
}

/** Runs one instance's worker until it has nothing due. */
async function deliver(i: Instance): Promise<void> {
  await i.worker.runOnce();
}

const rowsTo = (i: Instance, to: string) =>
  i.prisma.mailMessage.findMany({
    where: { recipientHash: recipientHash(mailTestOptions().recipientKey, to) },
    orderBy: { createdAt: 'asc' },
  });

describe.skipIf(skipWithoutMailpit)('mail outbox (PostgreSQL + Mailpit)', () => {
  let main: Instance;
  const extra: Instance[] = [];
  const addresses: string[] = [];
  const address = () => {
    const value = testAddress();
    addresses.push(value);
    return value;
  };

  beforeAll(async () => {
    main = await instance();
  });
  beforeEach(async () => {
    manual(main.worker);
    await main.worker.idle();
    await resetDatabase(main.prisma);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await disarmChaos();
    for (const i of extra.splice(0)) await i.app.close();
    for (const to of addresses.splice(0)) await deleteMessagesTo(to);
  });
  afterAll(async () => {
    await main.app.close();
  });

  it('delivers a queued message through SMTP, then keeps only its hash', async () => {
    const to = address();
    await expect(queue(main, to)).resolves.toBe('queued');
    await deliver(main);

    const [received] = await messagesTo(to);
    expect(received?.Subject).toBe('Test message from Integration');
    expect(received?.From).toEqual({ Address: 'no-reply@example.test', Name: 'Integration' });
    const [row] = await rowsTo(main, to);
    expect(row).toMatchObject({ status: 'sent', attempts: 1, recipient: null, lockedUntil: null });
    expect(row?.sentAt).toBeInstanceOf(Date);
    expect(received?.MessageID).toBe(`${row?.id ?? ''}@example.test`);
    const { headers, text } = await readMessage(received?.ID ?? '');
    expect(headers['Auto-Submitted']).toEqual(['auto-generated']);
    expect(text).toContain(row?.id);
  });

  it('queues nothing when the business transaction rolls back', async () => {
    const to = address();
    await expect(
      main.prisma.$transaction(async (tx) => {
        await main.outbox.enqueue(tx, { kind: 'test', to });
        throw new Error('the business change failed');
      }),
    ).rejects.toThrow('the business change failed');
    await deliver(main);
    expect(await rowsTo(main, to)).toEqual([]);
    expect(await messagesTo(to)).toEqual([]);
  });

  it('retries a transient refusal later, then delivers it', async () => {
    const to = address();
    await failRecipients(451);
    await queue(main, to);
    await deliver(main);
    const [waiting] = await rowsTo(main, to);
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1, lastError: 'smtp_4xx_451' });
    expect(waiting?.recipient).toBe(to);
    expect(waiting?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(main.worker.health()).toBe('degraded');

    await disarmChaos();
    await main.prisma.mailMessage.updateMany({ data: { nextAttemptAt: new Date() } });
    await deliver(main);
    expect(await rowsTo(main, to)).toMatchObject([{ status: 'sent', attempts: 2 }]);
    expect(await messagesTo(to)).toHaveLength(1);
    expect(main.worker.health()).toBe('ok');
  });

  it('gives up on a permanent refusal, keeps the address, and sends it again on a manual retry', async () => {
    const to = address();
    await failRecipients(550);
    await queue(main, to);
    await deliver(main);
    const [failed] = await rowsTo(main, to);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastError: 'smtp_5xx_550' });
    expect(failed?.recipient).toBe(to);

    await disarmChaos();
    await expect(main.store.retryFailed({ id: failed?.id ?? '' })).resolves.toBe(1);
    await deliver(main);
    expect(await rowsTo(main, to)).toMatchObject([{ status: 'sent', attempts: 1 }]);
  });

  it('retries while the SMTP server is unreachable, and reads as degraded meanwhile', async () => {
    const down = await instance({ smtpUrl: UNREACHABLE_SMTP_URL });
    extra.push(down);
    const to = address();
    await queue(down, to);
    await deliver(down);
    expect(await rowsTo(down, to)).toMatchObject([
      { status: 'pending', attempts: 1, lastError: 'connection' },
    ]);
    expect(down.worker.health()).toBe('degraded');
    const ready = await request(down.server).get('/api/health/ready').expect(200);
    expect(envelopeOf<{ status: string; checks: { mail: string } }>(ready).data).toMatchObject({
      status: 'degraded',
      checks: { mail: 'degraded' },
    });
  });

  it('delivers what was queued while no API instance was running', async () => {
    const to = [address(), address(), address()];
    for (const each of to) await queue(main, each);
    expect(await main.prisma.mailMessage.count({ where: { status: 'pending' } })).toBe(3);
    // A fresh instance (a restart) finds them in the database: its worker
    // drains the queue when it boots, before anyone asks.
    const restarted = await instance({}, MAIL_TEMPLATE_REGISTRY, { automatic: true });
    extra.push(restarted);
    await vi.waitFor(
      async () => {
        expect(await main.prisma.mailMessage.count({ where: { status: 'sent' } })).toBe(3);
      },
      { timeout: 10_000 },
    );
    for (const each of to) expect(await messagesTo(each)).toHaveLength(1);
  });

  it('sends each message once when several instances drain the queue at the same time', async () => {
    const others = [await instance(), await instance()];
    extra.push(...others);
    const to = Array.from({ length: 12 }, () => address());
    for (const each of to) await queue(main, each);
    await Promise.all([main, ...others].map((i) => deliver(i)));

    const rows = await main.prisma.mailMessage.findMany();
    expect(rows).toHaveLength(12);
    expect(rows.every((row) => row.status === 'sent' && row.attempts === 1)).toBe(true);
    for (const each of to) expect(await messagesTo(each)).toHaveLength(1);
  });

  it('takes over the message of a worker that died mid-send, once its lease ran out', async () => {
    const to = address();
    await queue(main, to);
    // The worker dies after the server accepted the message, before recording it.
    vi.spyOn(main.store, 'markSent').mockRejectedValueOnce(new Error('process died'));
    await deliver(main);
    const [orphan] = await rowsTo(main, to);
    expect(orphan).toMatchObject({ status: 'sending', attempts: 1 });
    expect(await messagesTo(to)).toHaveLength(1);

    // Until the lease ends, nobody touches it.
    const other = await instance();
    extra.push(other);
    await deliver(other);
    expect(await rowsTo(main, to)).toMatchObject([{ status: 'sending', attempts: 1 }]);

    // Then another worker takes it over: delivered at least once, here twice,
    // with the same Message-ID (docs/architecture.md#email).
    await main.prisma.mailMessage.updateMany({ data: { lockedUntil: new Date(Date.now() - 1) } });
    await deliver(other);
    expect(await rowsTo(main, to)).toMatchObject([{ status: 'sent', attempts: 2 }]);
    const copies = await messagesTo(to);
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((copy) => copy.MessageID)).size).toBe(1);
  });

  it('drops a message past its expiry unsent, and its address with it', async () => {
    const to = address();
    await queue(main, to);
    await main.prisma.mailMessage.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    await deliver(main);
    expect(await rowsTo(main, to)).toMatchObject([
      { status: 'expired', recipient: null, lastError: 'expired' },
    ]);
    expect(await messagesTo(to)).toEqual([]);
  });

  it('fails a message that keeps killing its worker, without sending it again', async () => {
    const to = address();
    await queue(main, to);
    await main.prisma.mailMessage.updateMany({
      data: { status: 'sending', attempts: 8, lockedUntil: new Date(Date.now() - 1) },
    });
    await deliver(main);
    expect(await rowsTo(main, to)).toMatchObject([
      { status: 'failed', attempts: 9, lastError: 'attempts_exhausted' },
    ]);
    expect(await messagesTo(to)).toEqual([]);
  });

  it('queues a message once for a dedupe key, inside or across transactions', async () => {
    const to = address();
    await expect(queue(main, to, { dedupeKey: 'same' })).resolves.toBe('queued');
    await expect(queue(main, to, { dedupeKey: 'same' })).resolves.toBe('duplicate');
    expect(await rowsTo(main, to)).toHaveLength(1);
  });

  describe('per-address limits', () => {
    const limited = { test: { ...testTemplate, limited: true } };

    it('holds back a second message within a minute, across instances and concurrent requests', async () => {
      const a = await instance({}, limited);
      const b = await instance({}, limited);
      extra.push(a, b);
      const to = address();
      const results = await Promise.all([
        queue(a, to),
        queue(b, to),
        queue(a, to.toUpperCase()),
        queue(b, `  ${to} `),
      ]);
      expect(results.filter((result) => result === 'queued')).toHaveLength(1);
      expect(results.filter((result) => result === 'suppressed')).toHaveLength(3);
      expect(await rowsTo(a, to)).toHaveLength(1);
    });

    it('holds back past the daily limit', async () => {
      const a = await instance({ dailyLimitPerAddress: 2 }, limited);
      extra.push(a);
      const to = address();
      await queue(a, to);
      await a.prisma.mailMessage.updateMany({
        data: { createdAt: new Date(Date.now() - 3_600_000) },
      });
      await expect(queue(a, to)).resolves.toBe('queued');
      await a.prisma.mailMessage.updateMany({
        data: { createdAt: new Date(Date.now() - 3_600_000) },
      });
      await expect(queue(a, to)).resolves.toBe('suppressed');
      // A day later the address may be written to again.
      await a.prisma.mailMessage.updateMany({
        data: { createdAt: new Date(Date.now() - 86_400_001) },
      });
      await expect(queue(a, to)).resolves.toBe('queued');
    });
  });

  it('when email is off, queues nothing and reports email as disabled', async () => {
    const off = await instance({ smtpUrl: undefined });
    extra.push(off);
    const to = address();
    await expect(queue(off, to)).resolves.toBe('disabled');
    expect(await rowsTo(off, to)).toEqual([]);
    const ready = await request(off.server).get('/api/health/ready').expect(200);
    expect(envelopeOf<{ checks: { mail: string } }>(ready).data.checks.mail).toBe('disabled');
  });

  it('reports email as ok on the readiness probe once deliveries work', async () => {
    await queue(main, address());
    await deliver(main);
    const ready = await request(main.server).get('/api/health/ready').expect(200);
    expect(envelopeOf<{ status: string; checks: { mail: string } }>(ready).data).toMatchObject({
      status: 'ok',
      checks: { mail: 'ok' },
    });
  });

  it('refuses invalid states in the database itself, whatever the code does', async () => {
    const to = address();
    await queue(main, to);
    // A sent row that kept its address; a claimed row without a lease.
    await expect(
      main.prisma.mailMessage.updateMany({ data: { status: 'sent', sentAt: new Date() } }),
    ).rejects.toThrow(/mail_messages_recipient_check/);
    await expect(
      main.prisma.mailMessage.updateMany({ data: { status: 'sending', lockedUntil: null } }),
    ).rejects.toThrow(/mail_messages_sending_lease_check/);
    await expect(main.prisma.mailMessage.updateMany({ data: { attempts: -1 } })).rejects.toThrow(
      /mail_messages_attempts_check/,
    );
  });

  it('deletes finished rows after 30 days and clears the address of old failed ones', async () => {
    const [old, recent, failing] = [address(), address(), address()];
    for (const each of [old, recent, failing]) await queue(main, each);
    await deliver(main);
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    const hash = (to: string) => recipientHash(mailTestOptions().recipientKey, to);
    await main.prisma.mailMessage.updateMany({
      where: { recipientHash: hash(old) },
      data: { createdAt: daysAgo(31) },
    });
    await main.prisma.mailMessage.updateMany({
      where: { recipientHash: hash(failing) },
      data: { status: 'failed', sentAt: null, recipient: failing, updatedAt: daysAgo(8) },
    });
    await expect(main.store.sweep()).resolves.toEqual({ deleted: 1, cleared: 1 });
    expect(await rowsTo(main, old)).toEqual([]);
    expect(await rowsTo(main, recent)).toHaveLength(1);
    expect(await rowsTo(main, failing)).toMatchObject([{ status: 'failed', recipient: null }]);
  });

  it('left alone, a worker sends a committed message within seconds, without being asked', async () => {
    const alone = await instance({}, MAIL_TEMPLATE_REGISTRY, { automatic: true });
    extra.push(alone);
    const to = address();
    await queue(alone, to);
    await vi.waitFor(
      async () => {
        expect(await messagesTo(to)).toHaveLength(1);
      },
      { timeout: 10_000, interval: 100 },
    );
  });
});

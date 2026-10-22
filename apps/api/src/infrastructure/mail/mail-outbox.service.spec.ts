import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../prisma/generated/client.js';
import { MailOutboxService } from './mail-outbox.service.js';
import { deriveRecipientKey, recipientHash } from './mail.recipient.js';
import type { MailOptions } from './mail.types.js';
import type { MailTemplate, MailTemplates } from './templates/registry.js';

const metrics = vi.hoisted(() => ({ recordMailDelivery: vi.fn(), recordMailSuppressed: vi.fn() }));
vi.mock('../../observability/metrics.js', () => metrics);

const options: MailOptions = {
  smtpUrl: 'smtp://localhost:1035',
  from: { address: 'no-reply@acme.test' },
  appOrigin: 'https://app.acme.test',
  appBasePath: '/app',
  maxAttempts: 8,
  dailyLimitPerAddress: 3,
  production: false,
  recipientKey: deriveRecipientKey('k'.repeat(64)),
};

const template = (limited: boolean): MailTemplate => ({
  limited,
  ttlMs: 30 * 60_000,
  compose: () => Promise.resolve(null),
});

/** Every kind with the same template; the specs queue `test` messages. */
const registry = (limited: boolean): MailTemplates => ({
  test: template(limited),
  password_reset: template(limited),
  password_changed: template(limited),
  sign_up_confirmation: template(limited),
  sign_up_existing: template(limited),
  email_change_confirmation: template(limited),
  email_change_existing: template(limited),
  email_changed: template(limited),
  invitation: template(limited),
});

function txWith({ minute = 0, day = 0, created = 1 } = {}) {
  const count = vi
    .fn<(args: { where: { createdAt: { gt: Date } } }) => Promise<number>>()
    .mockImplementation(({ where }) =>
      Promise.resolve(Date.now() - where.createdAt.gt.getTime() <= 60_000 ? minute : day),
    );
  const tx = {
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    mailMessage: {
      count,
      createMany: vi.fn(() => Promise.resolve({ count: created })),
    },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-13T10:00:00Z') });
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MailOutboxService', () => {
  const limited = new MailOutboxService(options, registry(true));
  const unlimited = new MailOutboxService(options, registry(false));

  it("drops, unsent, an account's waiting messages of a kind from a payload number on", async () => {
    const { tx, client } = txWith();
    tx.$executeRaw.mockResolvedValueOnce(2);
    await expect(
      unlimited.expireQueued(client, {
        kind: 'email_changed',
        userId: 'u1',
        key: 'securityVersion',
        from: 4,
        reason: 'superseded',
      }),
    ).resolves.toBe(2);
    const [sql, ...values] = tx.$executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const statement = sql.join('?');
    // The address goes with it, as for any dropped message (the CHECK constraint).
    expect(statement).toContain(
      `SET "status" = 'expired', "recipient" = NULL, "locked_until" = NULL`,
    );
    expect(statement).toContain(`"status" IN ('pending', 'sending', 'failed')`);
    // A message without the number (queued by the previous release) goes too.
    expect(statement).toContain('ELSE true END');
    expect(values).toEqual([
      'superseded',
      'u1',
      'email_changed',
      'securityVersion',
      'securityVersion',
      4,
    ]);
  });

  it('counts the messages a caller dropped, once its transaction committed', () => {
    metrics.recordMailDelivery.mockClear();
    unlimited.recordExpired('email_changed', 2);
    expect(metrics.recordMailDelivery).toHaveBeenCalledTimes(2);
    expect(metrics.recordMailDelivery).toHaveBeenCalledWith('email_changed', 'expired');
    unlimited.recordExpired('email_changed', 0);
    expect(metrics.recordMailDelivery).toHaveBeenCalledTimes(2);
  });

  it('queues nothing when email is off: no row, no token to deliver later', async () => {
    const off = new MailOutboxService({ ...options, smtpUrl: undefined }, registry(true));
    const { tx, client } = txWith();
    expect(off.enabled).toBe(false);
    await expect(off.enqueue(client, { kind: 'test', to: 'ada@example.test' })).resolves.toBe(
      'disabled',
    );
    expect(tx.mailMessage.createMany).not.toHaveBeenCalled();
  });

  it('queues the message in the caller transaction, normalized, with its keyed hash and expiry', async () => {
    const { tx, client } = txWith();
    await expect(
      limited.enqueue(client, {
        kind: 'test',
        to: '  Ada@Example.TEST ',
        userId: 'u1',
        payload: { tokenId: 't1' },
        dedupeKey: 'test:u1:1',
        requestId: 'req-1',
      }),
    ).resolves.toBe('queued');
    expect(tx.mailMessage.createMany).toHaveBeenCalledWith({
      data: [
        {
          kind: 'test',
          recipient: 'ada@example.test',
          recipientHash: recipientHash(options.recipientKey, 'ada@example.test'),
          userId: 'u1',
          payload: { tokenId: 't1' },
          dedupeKey: 'test:u1:1',
          expiresAt: new Date('2026-10-13T10:30:00Z'),
          requestId: 'req-1',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('serializes concurrent requests for one address on its advisory lock before counting', async () => {
    const { tx, client } = txWith();
    await limited.enqueue(client, { kind: 'test', to: 'ada@example.test' });
    const [sql, key] = tx.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, string];
    expect(sql.join('?')).toContain('pg_advisory_xact_lock(hashtextextended(?, 0))');
    expect(key).toBe(`mail-recipient:${recipientHash(options.recipientKey, 'ada@example.test')}`);
  });

  it('holds back a second message to an address within a minute', async () => {
    const { tx, client } = txWith({ minute: 1, day: 1 });
    await expect(limited.enqueue(client, { kind: 'test', to: 'ada@example.test' })).resolves.toBe(
      'suppressed',
    );
    expect(tx.mailMessage.createMany).not.toHaveBeenCalled();
  });

  it('holds back past the daily limit, whatever the case of the address', async () => {
    const { tx, client } = txWith({ minute: 0, day: 3 });
    await expect(limited.enqueue(client, { kind: 'test', to: 'ADA@example.test' })).resolves.toBe(
      'suppressed',
    );
    expect(tx.mailMessage.createMany).not.toHaveBeenCalled();
    const { client: below } = txWith({ minute: 0, day: 2 });
    await expect(limited.enqueue(below, { kind: 'test', to: 'ada@example.test' })).resolves.toBe(
      'queued',
    );
  });

  it('never holds back a kind that is not limited (security notices, operator tests)', async () => {
    const { tx, client } = txWith({ minute: 5, day: 50 });
    await expect(unlimited.enqueue(client, { kind: 'test', to: 'ada@example.test' })).resolves.toBe(
      'queued',
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.mailMessage.count).not.toHaveBeenCalled();
  });

  it('answers duplicate when the dedupe key was queued before, without aborting the transaction', async () => {
    const { client } = txWith({ created: 0 });
    await expect(
      unlimited.enqueue(client, { kind: 'test', to: 'ada@example.test', dedupeKey: 'k' }),
    ).resolves.toBe('duplicate');
  });

  it('wakes the worker of this process after a commit, and does nothing without one', () => {
    const outbox = new MailOutboxService(options, registry(false));
    outbox.notifyQueued();
    const listener = vi.fn();
    outbox.onQueued(listener);
    outbox.notifyQueued();
    expect(listener).toHaveBeenCalledOnce();
  });
});

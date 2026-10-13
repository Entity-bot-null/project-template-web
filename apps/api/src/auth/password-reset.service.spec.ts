import {
  BadRequestException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailOutboxService } from '../infrastructure/mail/mail-outbox.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { hashAccountToken } from './account-tokens.js';
import { checkPassword } from './password.js';
import { INVALID_RESET_LINK, PasswordResetService } from './password-reset.service.js';

// The transaction's SQL, locks and concurrency run against PostgreSQL in
// password-reset.int.spec.ts; here, the order of the decisions.

const USER = { id: 'u1', email: 'ada@example.test', name: 'Ada Lovelace', securityVersion: 2 };
const TOKEN = 'a'.repeat(43);
const GOOD = 'violet harbour lantern 7';

interface Setup {
  enabled?: boolean;
  /** The account the token names; null: none. */
  owner?: typeof USER | null;
  /** What the locked SELECT of the token finds. */
  tokenRows?: unknown[];
}

function setup({
  enabled = true,
  owner = USER,
  tokenRows = [
    {
      id: 't1',
      userId: 'u1',
      securityVersion: 2,
      email: 'ada@example.test',
      expiresAt: new Date(Date.now() + 60_000),
    },
  ],
}: Setup = {}) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: vi.fn((sql: TemplateStringsArray) => {
      const statement = sql.join('?');
      calls.push(statement.includes('"users"') ? 'lock user' : 'select token');
      return Promise.resolve(statement.includes('"users"') ? [] : tokenRows);
    }),
    user: {
      findUnique: vi.fn(() => Promise.resolve(owner)),
      update: vi.fn((args: unknown) => {
        calls.push('update user');
        return Promise.resolve(args);
      }),
    },
    session: {
      updateMany: vi.fn(() => {
        calls.push('revoke sessions');
        return Promise.resolve({ count: 2 });
      }),
    },
    accountToken: {
      findUnique: vi.fn(() => Promise.resolve(owner === null ? null : { userId: owner.id })),
      updateMany: vi.fn(() => {
        calls.push('consume token');
        return Promise.resolve({ count: 1 });
      }),
      deleteMany: vi.fn(() => {
        calls.push('drop other links');
        return Promise.resolve({ count: 0 });
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const mail = {
    enabled,
    enqueue: vi.fn(() => {
      calls.push('queue notice');
      return Promise.resolve('queued');
    }),
    notifyQueued: vi.fn(),
  };
  const service = new PasswordResetService(
    prisma as unknown as PrismaService,
    mail as unknown as MailOutboxService,
  );
  return { service, prisma, tx, mail, calls };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('PasswordResetService.request', () => {
  it('answers before looking anything up, then queues a link for an account', async () => {
    const { service, prisma, mail } = setup();
    service.request('  Ada@Example.TEST ');
    // Nothing awaited yet: the caller has already answered.
    expect(mail.enqueue).not.toHaveBeenCalled();
    await service.settled();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'ada@example.test' },
      select: { id: true, email: true },
    });
    expect(mail.enqueue).toHaveBeenCalledWith(expect.anything(), {
      kind: 'password_reset',
      to: 'ada@example.test',
      userId: 'u1',
    });
    expect(mail.notifyQueued).toHaveBeenCalledOnce();
  });

  it('queues nothing for an address without an account, and says nothing different', async () => {
    const { service, mail } = setup({ owner: null });
    service.request('nobody@example.test');
    await service.settled();
    expect(mail.enqueue).not.toHaveBeenCalled();
    expect(mail.notifyQueued).not.toHaveBeenCalled();
  });

  it('does not wake the worker when the address got its share of messages', async () => {
    const { service, mail } = setup();
    mail.enqueue.mockResolvedValueOnce('suppressed');
    service.request('ada@example.test');
    await service.settled();
    expect(mail.notifyQueued).not.toHaveBeenCalled();
  });

  it('logs a failure after the answer instead of losing it in an unhandled rejection', async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValueOnce(new Error('database down'));
    service.request('ada@example.test');
    await service.settled();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Could not queue a password reset message: database down',
    );
  });

  it('answers 503 when this deployment sends no email', () => {
    const { service } = setup({ enabled: false });
    expect(service.available).toBe(false);
    expect(() => {
      service.request('ada@example.test');
    }).toThrow(ServiceUnavailableException);
  });
});

describe('PasswordResetService.confirm', () => {
  it('in one transaction, under the account lock: takes the token, replaces the password, ends every session, drops other links, queues a notice', async () => {
    const { service, tx, mail, calls } = setup();
    await service.confirm(TOKEN, GOOD);
    expect(calls).toEqual([
      'lock user',
      'select token',
      'consume token',
      'update user',
      'revoke sessions',
      'drop other links',
      'queue notice',
    ]);
    const [[{ data }]] = tx.user.update.mock.calls as unknown as [
      [{ data: { passwordHash: string; securityVersion: unknown } }],
    ];
    expect(data.securityVersion).toEqual({ increment: 1 });
    await expect(checkPassword(data.passwordHash, GOOD)).resolves.toBe(true);
    expect(mail.enqueue).toHaveBeenCalledWith(expect.anything(), {
      kind: 'password_changed',
      to: 'ada@example.test',
      userId: 'u1',
      payload: { changedAt: expect.any(String) as string, via: 'reset' },
    });
    expect(mail.notifyQueued).toHaveBeenCalledOnce();
    const [, hash] = tx.$queryRaw.mock.calls[1] as unknown as [unknown, string];
    expect(hash).toBe(hashAccountToken(TOKEN));
  });

  it('refuses a weak password before taking the token: the link still works', async () => {
    const { service, prisma, calls } = setup();
    for (const weak of ['short', 'correcthorsebatterystaple', 'ada lovelace forever more']) {
      await expect(service.confirm(TOKEN, weak)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('answers 404 for a link that does not work, without saying why', async () => {
    const unknown = setup({ owner: null });
    await expect(unknown.service.confirm(TOKEN, GOOD)).rejects.toThrow(
      new NotFoundException(INVALID_RESET_LINK),
    );
    const used = setup({ tokenRows: [] });
    await expect(used.service.confirm(TOKEN, GOOD)).rejects.toThrow(INVALID_RESET_LINK);
    expect(used.tx.user.update).not.toHaveBeenCalled();
    expect(used.mail.notifyQueued).not.toHaveBeenCalled();
  });

  it('answers 404 when the account disappeared meanwhile', async () => {
    const { service, tx } = setup();
    tx.user.findUnique.mockResolvedValueOnce(USER).mockResolvedValueOnce(null);
    await expect(service.confirm(TOKEN, GOOD)).rejects.toThrow(INVALID_RESET_LINK);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

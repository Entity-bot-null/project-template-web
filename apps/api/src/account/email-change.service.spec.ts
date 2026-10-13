import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashAccountToken } from '../auth/account-tokens.js';
import { checkPassword, hashPassword } from '../auth/password.js';
import type { MailOutboxService } from '../infrastructure/mail/mail-outbox.service.js';
import { Prisma } from '../prisma/generated/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  ADDRESS_TAKEN,
  EmailChangeService,
  INVALID_EMAIL_LINK,
  SAME_ADDRESS,
  WRONG_CURRENT_PASSWORD,
} from './email-change.service.js';

// The transaction's SQL, locks and the attack the undo link defeats run
// against PostgreSQL in email-change.int.spec.ts; here, the decisions.

const NOW = Date.parse('2026-10-13T10:00:00Z');
const TOKEN = 'c'.repeat(43);
const CURRENT = 'lantern harbour violet 41';
const GOOD = 'violet harbour lantern 7';
const ACCOUNT = { id: 'u1', email: 'ada@example.test', name: 'Ada Lovelace', securityVersion: 3 };

interface Setup {
  mailEnabled?: boolean;
  /** The account of the request, null: gone. */
  user?: Record<string, unknown> | null;
  /** The account that owns the new address, null: none. */
  addressOwner?: { id: string } | null;
  /** What the token's hash finds before the transaction. */
  tokenRow?: { userId: string; purpose: string; targetEmail: string | null } | null;
  /** What the locked SELECT of the token finds. */
  lockedRows?: unknown[];
}

async function setup({
  mailEnabled = true,
  user,
  addressOwner = null,
  tokenRow = { userId: 'u1', purpose: 'email_change', targetEmail: 'new@example.test' },
  lockedRows,
}: Setup = {}) {
  const passwordHash = await hashPassword(CURRENT);
  const account = user === undefined ? { ...ACCOUNT, passwordHash } : user;
  const calls: string[] = [];
  const tx = {
    $queryRaw: vi.fn((sql: TemplateStringsArray) => {
      const statement = sql.join('?');
      calls.push(statement.includes('"users"') ? 'lock account' : 'take token');
      return Promise.resolve(
        statement.includes('"users"')
          ? []
          : (lockedRows ?? [
              {
                id: 't1',
                userId: 'u1',
                securityVersion: ACCOUNT.securityVersion,
                email: ACCOUNT.email,
                targetEmail: tokenRow?.targetEmail ?? null,
                expiresAt: new Date(NOW + 60_000),
              },
            ]),
      );
    }),
    user: {
      findUnique: vi.fn((args: { where: { id?: string; email?: string } }) =>
        Promise.resolve(args.where.email === undefined ? account : addressOwner),
      ),
      update: vi.fn((args: unknown) => {
        calls.push('update account');
        return Promise.resolve(args);
      }),
    },
    session: {
      updateMany: vi.fn(() => {
        calls.push('end sessions');
        return Promise.resolve({ count: 2 });
      }),
    },
    accountToken: {
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      deleteMany: vi.fn(() => {
        calls.push('drop other links');
        return Promise.resolve({ count: 0 });
      }),
      findUnique: vi.fn(() => Promise.resolve(tokenRow)),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const mail = {
    enabled: mailEnabled,
    enqueue: vi.fn((_tx: unknown, input: { kind: string }) => {
      calls.push(`queue ${input.kind}`);
      return Promise.resolve('queued');
    }),
    notifyQueued: vi.fn(),
  };
  const service = new EmailChangeService(
    prisma as unknown as PrismaService,
    mail as unknown as MailOutboxService,
  );
  return { service, prisma, tx, mail, calls };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('EmailChangeService.request', () => {
  it('checks the current password, answers, then queues a link to the new address', async () => {
    const { service, prisma, tx, mail } = await setup();
    // The lookup and the queueing are held up: the answer must not wait.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    prisma.$transaction.mockImplementationOnce((work) => held.then(() => work(tx)));
    await service.request('u1', CURRENT, '  New@Example.TEST ');
    expect(mail.enqueue).not.toHaveBeenCalled();
    release();
    await service.settled();
    expect(mail.enqueue).toHaveBeenCalledWith(expect.anything(), {
      kind: 'email_change_confirmation',
      to: 'new@example.test',
      userId: 'u1',
    });
    expect(mail.notifyQueued).toHaveBeenCalledOnce();
  });

  it('tells the owner of an address that has an account instead, answering the same', async () => {
    const { service, mail } = await setup({ addressOwner: { id: 'u2' } });
    await expect(service.request('u1', CURRENT, 'taken@example.test')).resolves.toBeUndefined();
    await service.settled();
    expect(mail.enqueue).toHaveBeenCalledWith(expect.anything(), {
      kind: 'email_change_existing',
      to: 'taken@example.test',
      userId: 'u2',
    });
  });

  it('refuses a wrong current password, the same address, and works only with email', async () => {
    const { service, mail } = await setup();
    await expect(service.request('u1', 'not the password', 'new@example.test')).rejects.toThrow(
      new ForbiddenException(WRONG_CURRENT_PASSWORD),
    );
    await expect(service.request('u1', CURRENT, ' ADA@example.test')).rejects.toThrow(
      new BadRequestException(SAME_ADDRESS),
    );
    await service.settled();
    expect(mail.enqueue).not.toHaveBeenCalled();
    const off = await setup({ mailEnabled: false });
    expect(off.service.available).toBe(false);
    await expect(off.service.request('u1', CURRENT, 'new@example.test')).rejects.toThrow(
      ServiceUnavailableException,
    );
    const gone = await setup({ user: null });
    await expect(gone.service.request('u1', CURRENT, 'new@example.test')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('logs a failure after the answer instead of losing it', async () => {
    const { service, prisma } = await setup();
    prisma.$transaction.mockRejectedValueOnce(new Error('database down'));
    await service.request('u1', CURRENT, 'new@example.test');
    await service.settled();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Could not queue a change of email: database down',
    );
  });
});

describe('EmailChangeService.confirm', () => {
  it('in one transaction, under the account lock: takes the token, moves the account, ends every session, notifies the previous address', async () => {
    const { service, tx, mail, calls } = await setup();
    await service.confirm(TOKEN, NOW);
    expect(calls).toEqual([
      'lock account',
      'take token',
      'update account',
      'end sessions',
      'drop other links',
      'queue email_changed',
    ]);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { email: 'new@example.test', securityVersion: { increment: 1 } },
    });
    expect(mail.enqueue).toHaveBeenCalledWith(expect.anything(), {
      kind: 'email_changed',
      to: 'ada@example.test',
      userId: 'u1',
      payload: { changedAt: new Date(NOW).toISOString() },
    });
    const [, hash] = tx.$queryRaw.mock.calls[1] as unknown as [unknown, string];
    expect(hash).toBe(hashAccountToken(TOKEN));
  });

  it.each([
    ['unknown', null],
    [
      'of another purpose',
      { userId: 'u1', purpose: 'email_revert', targetEmail: 'old@example.test' },
    ],
  ])('answers 404 for a token %s, before any transaction', async (_case, tokenRow) => {
    const { service, prisma } = await setup({ tokenRow });
    await expect(service.confirm(TOKEN, NOW)).rejects.toThrow(
      new NotFoundException(INVALID_EMAIL_LINK),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 404 when the account changed since the link was sent, or is gone', async () => {
    const stale = await setup({
      lockedRows: [
        {
          id: 't1',
          userId: 'u1',
          securityVersion: 2,
          email: 'ada@example.test',
          targetEmail: 'new@example.test',
          expiresAt: new Date(NOW + 60_000),
        },
      ],
    });
    await expect(stale.service.confirm(TOKEN, NOW)).rejects.toThrow(INVALID_EMAIL_LINK);
    expect(stale.tx.user.update).not.toHaveBeenCalled();
    const gone = await setup({ user: null });
    await expect(gone.service.confirm(TOKEN, NOW)).rejects.toThrow(INVALID_EMAIL_LINK);
  });

  it('answers 409 when the new address got an account meanwhile', async () => {
    const { service, tx, mail } = await setup();
    tx.user.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(service.confirm(TOKEN, NOW)).rejects.toThrow(new ConflictException(ADDRESS_TAKEN));
    expect(mail.notifyQueued).not.toHaveBeenCalled();
  });
});

describe('EmailChangeService.revert', () => {
  const revertRow = { userId: 'u1', purpose: 'email_revert', targetEmail: 'ada@example.test' };
  // The account as whoever took it left it: another address, a new password.
  const taken = { ...ACCOUNT, email: 'thief@example.test', securityVersion: 7 };

  it('puts the previous address back with a new password, whatever happened since, ending every session', async () => {
    const { service, tx, mail, calls } = await setup({
      user: taken,
      tokenRow: revertRow,
      lockedRows: [
        {
          id: 't9',
          userId: 'u1',
          securityVersion: 4,
          email: 'new@example.test',
          targetEmail: 'ada@example.test',
          expiresAt: new Date(NOW + 60_000),
        },
      ],
    });
    await service.revert(TOKEN, GOOD, NOW);
    expect(calls).toEqual([
      'lock account',
      'take token',
      'update account',
      'end sessions',
      'drop other links',
      'queue password_changed',
    ]);
    const [[{ data }]] = tx.user.update.mock.calls as unknown as [
      [{ data: { email: string; passwordHash: string; securityVersion: unknown } }],
    ];
    expect(data.email).toBe('ada@example.test');
    expect(data.securityVersion).toEqual({ increment: 1 });
    await expect(checkPassword(data.passwordHash, GOOD)).resolves.toBe(true);
    // Every other link of the account, other undo links included.
    expect(tx.accountToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', usedAt: null },
    });
    expect(mail.enqueue).toHaveBeenCalledWith(expect.anything(), {
      kind: 'password_changed',
      to: 'ada@example.test',
      userId: 'u1',
      payload: { changedAt: new Date(NOW).toISOString(), via: 'reset' },
    });
  });

  it('refuses a weak password before taking the link, judged against the restored address', async () => {
    const { service, prisma } = await setup({ tokenRow: revertRow });
    for (const weak of ['short', 'correcthorsebatterystaple', 'ada@example.test is mine']) {
      await expect(service.revert(TOKEN, weak, NOW)).rejects.toThrow(BadRequestException);
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 404 for a token of another purpose, an expired one, or a gone account', async () => {
    const wrong = await setup();
    await expect(wrong.service.revert(TOKEN, GOOD, NOW)).rejects.toThrow(INVALID_EMAIL_LINK);
    const expired = await setup({
      tokenRow: revertRow,
      lockedRows: [
        {
          id: 't9',
          userId: 'u1',
          securityVersion: 4,
          email: 'new@example.test',
          targetEmail: 'ada@example.test',
          expiresAt: new Date(NOW),
        },
      ],
    });
    await expect(expired.service.revert(TOKEN, GOOD, NOW)).rejects.toThrow(INVALID_EMAIL_LINK);
    expect(expired.tx.user.update).not.toHaveBeenCalled();
    const gone = await setup({ tokenRow: revertRow, user: null });
    await expect(gone.service.revert(TOKEN, GOOD, NOW)).rejects.toThrow(INVALID_EMAIL_LINK);
  });

  it('answers 409 when the previous address got another account meanwhile, passes other failures on', async () => {
    const conflict = await setup({ tokenRow: revertRow });
    conflict.tx.user.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(conflict.service.revert(TOKEN, GOOD, NOW)).rejects.toThrow(ADDRESS_TAKEN);
    const failing = await setup({ tokenRow: revertRow });
    failing.tx.user.update.mockRejectedValueOnce(new Error('database down'));
    await expect(failing.service.revert(TOKEN, GOOD, NOW)).rejects.toThrow('database down');
  });
});

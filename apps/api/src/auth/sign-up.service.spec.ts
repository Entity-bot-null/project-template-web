import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailOutboxService } from '../infrastructure/mail/mail-outbox.service.js';
import { Prisma } from '../prisma/generated/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { hashAccountToken } from './account-tokens.js';
import type { AuthService } from './auth.service.js';
import { checkPassword, hashPassword } from './password.js';
import type { SessionsService } from './sessions.service.js';
import {
  ACCOUNT_EXISTS,
  INVALID_SIGN_UP_LINK,
  SIGN_UP_CLOSED,
  SignUpService,
  WRONG_SIGN_UP_PASSWORD,
} from './sign-up.service.js';

// The transaction's SQL, locks and concurrency run against PostgreSQL in
// sign-up.int.spec.ts; here, the order of the decisions.

const NOW = Date.parse('2026-10-13T10:00:00Z');
const TOKEN = 'b'.repeat(43);
const GOOD = 'violet harbour lantern 7';
const INPUT = { email: '  Ada@Example.TEST ', name: 'Ada Lovelace', password: GOOD };

interface Setup {
  enabled?: boolean;
  mailEnabled?: boolean;
  /** The account the address already has; null: none. */
  account?: { id: string } | null;
  /** The sign-up the link's token finds; null: none. */
  signUp?: Record<string, unknown> | null;
  /** What the locked SELECT of the sign-up finds. */
  lockedRows?: unknown[];
  /** failed_attempts after a wrong password. */
  attempts?: number;
}

async function setup({
  enabled = true,
  mailEnabled = true,
  account = null,
  signUp,
  lockedRows = [{ id: 's1' }],
  attempts = 1,
}: Setup = {}) {
  const passwordHash = await hashPassword(GOOD);
  const found =
    signUp === undefined
      ? {
          id: 's1',
          email: 'ada@example.test',
          name: 'Ada Lovelace',
          passwordHash,
          expiresAt: new Date(NOW + 60_000),
        }
      : signUp;
  const calls: string[] = [];
  const tx = {
    $executeRaw: vi.fn(() => {
      calls.push('lock address');
      return Promise.resolve(1);
    }),
    $queryRaw: vi.fn(() => {
      calls.push('lock sign-up');
      return Promise.resolve(lockedRows);
    }),
    user: {
      findUnique: vi.fn(() => Promise.resolve(account)),
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        calls.push('create account');
        return Promise.resolve({
          id: 'u9',
          email: args.data.email,
          name: args.data.name,
          role: args.data.role,
        });
      }),
    },
    signUp: {
      deleteMany: vi.fn(() => {
        calls.push('drop earlier sign-up');
        return Promise.resolve({ count: 1 });
      }),
      create: vi.fn(() => {
        calls.push('record sign-up');
        return Promise.resolve({ id: 's2' });
      }),
      delete: vi.fn(() => {
        calls.push('delete sign-up');
        return Promise.resolve({});
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    $queryRaw: vi.fn(() => Promise.resolve([{ failedAttempts: attempts }])),
    signUp: {
      findUnique: vi.fn(() => Promise.resolve(found)),
      deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const mail = {
    enabled: mailEnabled,
    enqueue: vi.fn((_tx: unknown, input: { kind: string }) => {
      calls.push(`queue ${input.kind}`);
      return Promise.resolve('queued');
    }),
    notifyQueued: vi.fn(),
  };
  const refresh = { token: 'refresh', expiresAt: new Date(NOW + 1000), securityVersion: 0 };
  const sessions = {
    create: vi.fn(() => {
      calls.push('start session');
      return Promise.resolve(refresh);
    }),
    retire: vi.fn(() => {
      calls.push('end previous session');
      return Promise.resolve();
    }),
  };
  const auth = { sessionFor: vi.fn(() => Promise.resolve({ accessToken: 'access' })) };
  const service = new SignUpService(
    prisma as unknown as PrismaService,
    mail as unknown as MailOutboxService,
    sessions as unknown as SessionsService,
    auth as unknown as AuthService,
    enabled,
  );
  return { service, prisma, tx, mail, sessions, auth, calls, passwordHash, refresh };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('SignUpService.request', () => {
  it('is closed unless SIGN_UP_ENABLED, and without email', async () => {
    for (const closed of [{ enabled: false }, { mailEnabled: false }]) {
      const { service, prisma } = await setup(closed);
      expect(service.available).toBe(false);
      expect(() => {
        service.request(INPUT);
      }).toThrow(new ForbiddenException(SIGN_UP_CLOSED));
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
  });

  it('refuses a weak password before anything else, saying nothing about the address', async () => {
    const { service, prisma } = await setup();
    for (const weak of ['short', 'correcthorsebatterystaple', 'ada lovelace forever more']) {
      expect(() => {
        service.request({ ...INPUT, password: weak });
      }).toThrow(BadRequestException);
    }
    await service.settled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers first, then replaces the earlier sign-up of a new address and queues its link', async () => {
    const { service, tx, mail, calls } = await setup();
    service.request(INPUT);
    expect(mail.enqueue).not.toHaveBeenCalled();
    await service.settled();
    expect(calls).toEqual([
      'lock address',
      'drop earlier sign-up',
      'record sign-up',
      'queue sign_up_confirmation',
    ]);
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'ada@example.test' },
      select: { id: true },
    });
    const [[{ data }]] = tx.signUp.create.mock.calls as unknown as [
      [{ data: { email: string; name: string; passwordHash: string } }],
    ];
    expect(data).toMatchObject({ email: 'ada@example.test', name: 'Ada Lovelace' });
    await expect(checkPassword(data.passwordHash, GOOD)).resolves.toBe(true);
    expect(mail.enqueue).toHaveBeenCalledWith(expect.anything(), {
      kind: 'sign_up_confirmation',
      to: 'ada@example.test',
      payload: { signUpId: 's2' },
    });
    expect(mail.notifyQueued).toHaveBeenCalledOnce();
  });

  it('tells the owner of an existing account instead, creating no sign-up', async () => {
    const { service, tx, mail, calls } = await setup({ account: { id: 'u1' } });
    service.request(INPUT);
    await service.settled();
    expect(calls).toEqual(['lock address', 'queue sign_up_existing']);
    expect(mail.enqueue).toHaveBeenCalledWith(expect.anything(), {
      kind: 'sign_up_existing',
      to: 'ada@example.test',
      userId: 'u1',
    });
    expect(tx.signUp.create).not.toHaveBeenCalled();
  });

  it('rolls the replacement back when the address got its share of messages', async () => {
    const { service, prisma, mail } = await setup();
    mail.enqueue.mockResolvedValueOnce('suppressed');
    // The real transaction rolls back on the throw; this fake passes it on.
    service.request(INPUT);
    await service.settled();
    await expect(prisma.$transaction.mock.results[0]?.value).rejects.toThrow();
    expect(mail.notifyQueued).not.toHaveBeenCalled();
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('logs a failure after the answer instead of losing it', async () => {
    const { service, prisma } = await setup();
    prisma.$transaction.mockRejectedValueOnce(new Error('database down'));
    service.request(INPUT);
    await service.settled();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Could not record a sign-up: database down',
    );
  });
});

describe('SignUpService.confirm', () => {
  it('creates the account from the sign-up, under its lock, then signs it in', async () => {
    const { service, tx, sessions, calls, passwordHash, refresh } = await setup();
    const result = await service.confirm(TOKEN, GOOD, 'old-refresh', NOW);
    expect(calls).toEqual([
      'lock sign-up',
      'delete sign-up',
      'create account',
      'end previous session',
      'start session',
    ]);
    const [sql, ...values] = tx.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(sql.join('?')).toContain('FOR UPDATE');
    expect(values).toEqual(['s1', hashAccountToken(TOKEN)]);
    expect(tx.user.create).toHaveBeenCalledWith({
      data: { email: 'ada@example.test', name: 'Ada Lovelace', role: 'member', passwordHash },
      select: { id: true, email: true, name: true, role: true },
    });
    expect(sessions.retire).toHaveBeenCalledWith('old-refresh', 'sign-in');
    expect(sessions.create).toHaveBeenCalledWith('u9', passwordHash);
    expect(result).toEqual({ session: { accessToken: 'access' }, refresh });
  });

  it.each([
    ['unknown, replaced or used', null],
    ['never sent', { id: 's1', passwordHash: 'x', expiresAt: null }],
    ['expired', { id: 's1', passwordHash: 'x', expiresAt: new Date(NOW) }],
  ])('answers 404 for a link %s, without checking any password', async (_case, signUp) => {
    const { service, prisma } = await setup({ signUp });
    await expect(service.confirm(TOKEN, GOOD, undefined, NOW)).rejects.toThrow(
      new NotFoundException(INVALID_SIGN_UP_LINK),
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 401 for another password, counting it; the last allowed one drops the sign-up', async () => {
    const counted = await setup({ attempts: 4 });
    await expect(
      counted.service.confirm(TOKEN, 'not the password', undefined, NOW),
    ).rejects.toThrow(new UnauthorizedException(WRONG_SIGN_UP_PASSWORD));
    expect(counted.prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(counted.prisma.signUp.deleteMany).not.toHaveBeenCalled();
    expect(counted.prisma.$transaction).not.toHaveBeenCalled();

    const last = await setup({ attempts: 5 });
    await expect(last.service.confirm(TOKEN, 'not the password', undefined, NOW)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(last.prisma.signUp.deleteMany).toHaveBeenCalledWith({
      where: { id: 's1', tokenHash: hashAccountToken(TOKEN) },
    });
  });

  it('answers 404 without checking the password once every attempt is spent', async () => {
    const { service, prisma } = await setup();
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(service.confirm(TOKEN, GOOD, undefined, NOW)).rejects.toThrow(
      new NotFoundException(INVALID_SIGN_UP_LINK),
    );
    const [sql] = prisma.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray];
    expect(sql.join('?')).toContain('"failed_attempts" < ?');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 404 when the sign-up was replaced or used after its password was checked', async () => {
    const { service, tx, sessions } = await setup({ lockedRows: [] });
    await expect(service.confirm(TOKEN, GOOD, undefined, NOW)).rejects.toThrow(
      INVALID_SIGN_UP_LINK,
    );
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('answers 409 when the address got an account meanwhile (the unique email)', async () => {
    const { service, tx, sessions } = await setup();
    tx.user.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(service.confirm(TOKEN, GOOD, undefined, NOW)).rejects.toThrow(
      new ConflictException(ACCOUNT_EXISTS),
    );
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('passes any other failure on, and is closed when sign-up is', async () => {
    const failing = await setup();
    failing.tx.user.create.mockRejectedValueOnce(new Error('database down'));
    await expect(failing.service.confirm(TOKEN, GOOD, undefined, NOW)).rejects.toThrow(
      'database down',
    );
    const closed = await setup({ enabled: false });
    await expect(closed.service.confirm(TOKEN, GOOD, undefined, NOW)).rejects.toThrow(
      ForbiddenException,
    );
  });
});

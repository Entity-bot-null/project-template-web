import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashAccountToken } from '../auth/account-tokens.js';
import type { AuthService } from '../auth/auth.service.js';
import { checkPassword } from '../auth/password.js';
import type { SessionsService } from '../auth/sessions.service.js';
import type { MailOutboxService } from '../infrastructure/mail/mail-outbox.service.js';
import { Prisma } from '../prisma/generated/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  ACCOUNT_EXISTS,
  HELD_BACK,
  INVALID_INVITATION,
  InvitationsService,
} from './invitations.service.js';

// The transaction's SQL, locks and concurrency run against PostgreSQL in
// invitations.int.spec.ts; here, the order of the decisions.

const NOW = Date.parse('2026-10-13T10:00:00Z');
const TOKEN = 'd'.repeat(43);
const GOOD = 'violet harbour lantern 7';
const CREATED = {
  id: 'i2',
  email: 'ada@example.test',
  role: 'admin' as const,
  createdAt: new Date(NOW),
  expiresAt: null,
  invitedBy: { id: 'a1', name: 'Admin' },
};

interface Setup {
  mailEnabled?: boolean;
  /** The account the address already has; null: none. */
  account?: { id: string } | null;
  /** What the token's hash finds; null: none. */
  invitation?: Record<string, unknown> | null;
  /** What the locked SELECT of the invitation finds. */
  lockedRows?: unknown[];
}

function setup({
  mailEnabled = true,
  account = null,
  invitation = { id: 'i1', email: 'ada@example.test', expiresAt: new Date(NOW + 60_000) },
  lockedRows = [{ role: 'admin', inviterRole: 'admin' }],
}: Setup = {}) {
  const calls: string[] = [];
  const tx = {
    $executeRaw: vi.fn(() => {
      calls.push('lock address');
      return Promise.resolve(1);
    }),
    $queryRaw: vi.fn(() => {
      calls.push('lock invitation');
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
    invitation: {
      deleteMany: vi.fn(() => {
        calls.push('drop earlier invitation');
        return Promise.resolve({ count: 1 });
      }),
      create: vi.fn(() => {
        calls.push('record invitation');
        return Promise.resolve(CREATED);
      }),
      delete: vi.fn(() => {
        calls.push('delete invitation');
        return Promise.resolve({});
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn((work: unknown) =>
      typeof work === 'function'
        ? (work as (client: typeof tx) => Promise<unknown>)(tx)
        : Promise.all(work as Promise<unknown>[]),
    ),
    invitation: {
      findUnique: vi.fn(() => Promise.resolve(invitation)),
      findMany: vi.fn(() => Promise.resolve([CREATED])),
      count: vi.fn(() => Promise.resolve(1)),
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
  const service = new InvitationsService(
    prisma as unknown as PrismaService,
    mail as unknown as MailOutboxService,
    sessions as unknown as SessionsService,
    auth as unknown as AuthService,
  );
  return { service, prisma, tx, mail, sessions, calls, refresh };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('InvitationsService.invite', () => {
  it('replaces the earlier invitation of the address, records this one and queues its message', async () => {
    const { service, tx, mail, calls } = setup();
    const invited = await service.invite('a1', { email: '  Ada@Example.TEST ', role: 'admin' });
    expect(calls).toEqual([
      'lock address',
      'drop earlier invitation',
      'record invitation',
      'queue invitation',
    ]);
    expect(tx.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { email: 'ada@example.test', role: 'admin', invitedById: 'a1' },
      }),
    );
    expect(mail.enqueue).toHaveBeenCalledWith(expect.anything(), {
      kind: 'invitation',
      to: 'ada@example.test',
      payload: { invitationId: 'i2' },
    });
    expect(mail.notifyQueued).toHaveBeenCalledOnce();
    expect(invited).toEqual({
      id: 'i2',
      email: 'ada@example.test',
      role: 'admin',
      invitedBy: { id: 'a1', name: 'Admin' },
      createdAt: new Date(NOW).toISOString(),
      expiresAt: null,
    });
  });

  it('answers 409 for an address that has an account, changing nothing', async () => {
    const { service, tx, mail } = setup({ account: { id: 'u1' } });
    await expect(
      service.invite('a1', { email: 'ada@example.test', role: 'member' }),
    ).rejects.toThrow(new ConflictException(ACCOUNT_EXISTS));
    expect(tx.invitation.deleteMany).not.toHaveBeenCalled();
    expect(mail.enqueue).not.toHaveBeenCalled();
  });

  it('answers 429 when the address got its share of messages: the replacement rolls back', async () => {
    const { service, mail } = setup();
    mail.enqueue.mockResolvedValueOnce('suppressed');
    const refused = service.invite('a1', { email: 'ada@example.test', role: 'member' });
    await expect(refused).rejects.toThrow(HELD_BACK);
    await expect(refused).rejects.toBeInstanceOf(HttpException);
    await refused.catch((error: unknown) => {
      expect((error as HttpException).getStatus()).toBe(429);
    });
    expect(mail.notifyQueued).not.toHaveBeenCalled();
  });

  it('answers 503 without email, and passes other failures on', async () => {
    const off = setup({ mailEnabled: false });
    expect(off.service.available).toBe(false);
    await expect(
      off.service.invite('a1', { email: 'ada@example.test', role: 'member' }),
    ).rejects.toThrow(ServiceUnavailableException);
    const failing = setup();
    failing.prisma.$transaction.mockRejectedValueOnce(new Error('database down'));
    await expect(
      failing.service.invite('a1', { email: 'ada@example.test', role: 'member' }),
    ).rejects.toThrow('database down');
  });
});

describe('InvitationsService.list and revoke', () => {
  it('lists pending invitations newest first, paged', async () => {
    const { service, prisma } = setup();
    await expect(service.list({ limit: 20, offset: 40 })).resolves.toEqual({
      items: [expect.objectContaining({ id: 'i2', expiresAt: null })],
      total: 1,
    });
    expect(prisma.invitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        skip: 40,
      }),
    );
  });

  it('revokes one, and answers 404 for none', async () => {
    const { service, prisma } = setup();
    await service.revoke('a1', 'i1');
    expect(prisma.invitation.deleteMany).toHaveBeenCalledWith({ where: { id: 'i1' } });
    prisma.invitation.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.revoke('a1', 'i1')).rejects.toThrow(NotFoundException);
  });
});

describe('InvitationsService.accept', () => {
  it('creates the account with the invitation role under its lock, then signs it in', async () => {
    const { service, tx, sessions, calls, refresh } = setup();
    const result = await service.accept(TOKEN, 'Ada Lovelace', GOOD, 'old-refresh', NOW);
    expect(calls).toEqual([
      'lock address',
      'lock invitation',
      'delete invitation',
      'create account',
      'end previous session',
      'start session',
    ]);
    const [sql, ...values] = tx.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(sql.join('?')).toContain('FOR UPDATE');
    expect(values).toEqual(['i1', hashAccountToken(TOKEN)]);
    const [[{ data }]] = tx.user.create.mock.calls as unknown as [
      [{ data: { email: string; name: string; role: string; passwordHash: string } }],
    ];
    // The role is the invitation's, read under the lock: never the request's.
    expect(data).toMatchObject({ email: 'ada@example.test', name: 'Ada Lovelace', role: 'admin' });
    await expect(checkPassword(data.passwordHash, GOOD)).resolves.toBe(true);
    expect(sessions.retire).toHaveBeenCalledWith('old-refresh', 'sign-in');
    expect(result).toEqual({ session: { accessToken: 'access' }, refresh });
  });

  it.each([
    ['unknown, replaced, revoked or used', null],
    ['never sent', { id: 'i1', email: 'ada@example.test', expiresAt: null }],
    ['expired', { id: 'i1', email: 'ada@example.test', expiresAt: new Date(NOW) }],
  ])('answers 404 for an invitation %s', async (_case, invitation) => {
    const { service, prisma } = setup({ invitation });
    await expect(service.accept(TOKEN, 'Ada', GOOD, undefined, NOW)).rejects.toThrow(
      new NotFoundException(INVALID_INVITATION),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a weak password before taking the link, judged against the address and the name', async () => {
    const { service, prisma } = setup();
    for (const weak of ['short', 'correcthorsebatterystaple', 'lovelace is the best name']) {
      await expect(service.accept(TOKEN, 'Ada Lovelace', weak, undefined, NOW)).rejects.toThrow(
        BadRequestException,
      );
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['demoted since', 'member'],
    ['deleted since', null],
  ])(
    'answers 404 when whoever invited was %s: nobody vouches for it any more',
    async (_case, inviterRole) => {
      const { service, tx, sessions } = setup({ lockedRows: [{ role: 'admin', inviterRole }] });
      await expect(service.accept(TOKEN, 'Ada', GOOD, undefined, NOW)).rejects.toThrow(
        new NotFoundException(INVALID_INVITATION),
      );
      expect(tx.user.create).not.toHaveBeenCalled();
      expect(sessions.create).not.toHaveBeenCalled();
    },
  );

  it('answers 404 when the invitation changed after it was read, 409 for a taken address', async () => {
    const replaced = setup({ lockedRows: [] });
    await expect(replaced.service.accept(TOKEN, 'Ada', GOOD, undefined, NOW)).rejects.toThrow(
      INVALID_INVITATION,
    );
    expect(replaced.tx.user.create).not.toHaveBeenCalled();
    const taken = setup();
    taken.tx.user.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(taken.service.accept(TOKEN, 'Ada', GOOD, undefined, NOW)).rejects.toThrow(
      new ConflictException(ACCOUNT_EXISTS),
    );
    expect(taken.sessions.create).not.toHaveBeenCalled();
    const failing = setup();
    failing.tx.user.create.mockRejectedValueOnce(new Error('database down'));
    await expect(failing.service.accept(TOKEN, 'Ada', GOOD, undefined, NOW)).rejects.toThrow(
      'database down',
    );
  });
});

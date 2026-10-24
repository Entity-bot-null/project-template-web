import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../auth/auth.service.js';
import { checkPassword, hashPassword } from '../auth/password.js';
import type { SessionsService } from '../auth/sessions.service.js';
import type { MailOutboxService } from '../infrastructure/mail/mail-outbox.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AccountService } from './account.service.js';

// The transaction against PostgreSQL (locks, concurrent changes, sessions)
// is account.int.spec.ts; here, the order of the decisions.

const CURRENT = 'the current passphrase here';
const NEXT = 'violet harbour lantern 7';
let currentHash: string;

beforeAll(async () => {
  currentHash = await hashPassword(CURRENT);
});
beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

function setup({ storedHashInTransaction }: { storedHashInTransaction?: string } = {}) {
  const user = {
    id: 'u1',
    email: 'ada@example.test',
    name: 'Ada Lovelace',
    role: 'member' as const,
    passwordHash: currentHash,
  };
  const calls: string[] = [];
  const tx = {
    $queryRaw: vi.fn(() => {
      calls.push('lock user');
      return Promise.resolve([]);
    }),
    user: {
      findUnique: vi.fn(() =>
        Promise.resolve({
          email: user.email,
          passwordHash: storedHashInTransaction ?? currentHash,
        }),
      ),
      update: vi.fn((args: unknown) => {
        calls.push('update user');
        return Promise.resolve(args);
      }),
    },
    session: {
      updateMany: vi.fn(() => {
        calls.push('revoke sessions');
        return Promise.resolve({ count: 3 });
      }),
    },
    accountToken: {
      deleteMany: vi.fn(() => {
        calls.push('drop reset links');
        return Promise.resolve({ count: 1 });
      }),
    },
  };
  const prisma = {
    user: { findUnique: vi.fn(() => Promise.resolve(user)) },
    $transaction: vi.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const sessions = {
    create: vi.fn(() =>
      Promise.resolve({
        token: 'new-refresh',
        expiresAt: new Date(),
        familyId: 'family-new',
        securityVersion: 5,
      }),
    ),
  };
  const auth = {
    sessionFor: vi.fn((authUser: unknown, started: { securityVersion: number; familyId: string }) =>
      Promise.resolve({
        accessToken: `token-sv-${String(started.securityVersion)}`,
        expiresIn: 900,
        sessionId: started.familyId,
        user: authUser,
      }),
    ),
  };
  const mail = {
    enqueue: vi.fn(() => {
      calls.push('queue notice');
      return Promise.resolve('queued');
    }),
    notifyQueued: vi.fn(),
  };
  const service = new AccountService(
    prisma as unknown as PrismaService,
    auth as unknown as AuthService,
    sessions as unknown as SessionsService,
    mail as unknown as MailOutboxService,
  );
  return { service, prisma, tx, sessions, auth, mail, calls };
}

describe('AccountService.changePassword', () => {
  it('ends every session, then starts a new one for this browser, with the new password', async () => {
    const { service, tx, sessions, mail, calls } = setup();
    const result = await service.changePassword('u1', CURRENT, NEXT);
    expect(calls).toEqual([
      'lock user',
      'update user',
      'revoke sessions',
      'drop reset links',
      'queue notice',
    ]);
    const [[{ data }]] = tx.user.update.mock.calls as unknown as [
      [{ data: { passwordHash: string; securityVersion: unknown } }],
    ];
    expect(data.securityVersion).toEqual({ increment: 1 });
    await expect(checkPassword(data.passwordHash, NEXT)).resolves.toBe(true);
    // The new session is created with the new hash, after the old ones ended.
    expect(sessions.create).toHaveBeenCalledWith('u1', data.passwordHash);
    expect(result.session.accessToken).toBe('token-sv-5');
    expect(result.session.sessionId).toBe('family-new');
    expect(result.session.user).toEqual({
      id: 'u1',
      email: 'ada@example.test',
      name: 'Ada Lovelace',
      role: 'member',
    });
    expect(mail.enqueue).toHaveBeenCalledWith(expect.anything(), {
      kind: 'password_changed',
      to: 'ada@example.test',
      userId: 'u1',
      payload: { changedAt: expect.any(String) as string, via: 'change' },
    });
    expect(mail.notifyQueued).toHaveBeenCalledOnce();
  });

  it('refuses a weak new password with 400 before checking anything else', async () => {
    const { service, prisma } = setup();
    await expect(service.changePassword('u1', 'whatever', 'short')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.changePassword('u1', CURRENT, 'ada.lovelace with a long tail'),
    ).rejects.toThrow('newPassword: Leave your email address and your name out of your password.');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 403 for a wrong current password: the session stays, nothing changes', async () => {
    const { service, prisma } = setup();
    await expect(service.changePassword('u1', 'not the password', NEXT)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 409 when the password changed between the check and the transaction', async () => {
    const { service, tx, sessions } = setup({ storedHashInTransaction: 'changed meanwhile' });
    await expect(service.changePassword('u1', CURRENT, NEXT)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('answers 404 for an account that no longer exists', async () => {
    const { service, prisma } = setup();
    prisma.user.findUnique.mockResolvedValueOnce(null as never);
    await expect(service.changePassword('u1', CURRENT, NEXT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

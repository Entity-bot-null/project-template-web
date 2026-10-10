import { Logger, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  REFRESH_FAMILY_MAX_AGE_SEC,
  REFRESH_REUSE_LEEWAY_SEC,
  REFRESH_TOKEN_TTL_SEC,
} from './auth.constants.js';
import { hashRefreshToken, RefreshRaceLostException, SessionsService } from './sessions.service.js';

const USER = {
  id: '0190b6a1-0000-7000-8000-000000000001',
  email: 'user@example.com',
  name: 'User',
  role: 'member' as const,
};
const PASSWORD_HASH = '$argon2id$v=19$stored';
const FAMILY = '0190b6a1-0000-7000-8000-00000000000a';
const OTHER_FAMILY = '0190b6a1-0000-7000-8000-00000000000b';

interface Row {
  id: string;
  userId: string;
  familyId: string;
  familyExpiresAt: Date;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  rotated: boolean;
}

interface Where {
  id?: string;
  userId?: string;
  familyId?: string;
  tokenHash?: string;
  revokedAt?: null;
}

const matches = (row: Row, where: Where) =>
  (where.id === undefined || row.id === where.id) &&
  (where.userId === undefined || row.userId === where.userId) &&
  (where.familyId === undefined || row.familyId === where.familyId) &&
  (where.tokenHash === undefined || row.tokenHash === where.tokenHash) &&
  (where.revokedAt !== null || row.revokedAt === null);

// An in-memory stand-in for the sessions table, enough for the rotation
// rules. The real queries, locks and constraints are exercised by
// auth.int.spec.ts against PostgreSQL.
function fakePrisma(rows: Row[], storedPasswordHash = PASSWORD_HASH) {
  const session = {
    findUnique: vi.fn(({ where }: { where: Where }) => {
      const row = rows.find((candidate) => matches(candidate, where));
      return Promise.resolve(row ? { ...row, user: USER } : null);
    }),
    update: vi.fn(({ where, data }: { where: Where; data: Partial<Row> }) => {
      const row = rows.find((candidate) => matches(candidate, where));
      if (!row) return Promise.reject(new Error('Record to update not found'));
      Object.assign(row, data);
      return Promise.resolve(row);
    }),
    updateMany: vi.fn(({ where, data }: { where: Where; data: Partial<Row> }) => {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return Promise.resolve({ count: hit.length });
    }),
    create: vi.fn(({ data }: { data: Omit<Row, 'id' | 'revokedAt' | 'rotated'> }) => {
      const row = { ...data, id: `s${rows.length + 1}`, revokedAt: null, rotated: false };
      rows.push(row);
      return Promise.resolve(row);
    }),
    deleteMany: vi.fn(),
  };
  const user = {
    findUnique: vi.fn(() => Promise.resolve({ passwordHash: storedPasswordHash })),
  };
  // The user row lock (SELECT ... FOR UPDATE).
  const $queryRaw = vi.fn().mockResolvedValue([]);
  const tx = { session, user, $queryRaw };
  const prisma = {
    ...tx,
    $transaction: <T>(work: (client: typeof tx) => Promise<T>) => work(tx),
  };
  return { prisma: prisma as unknown as PrismaService, session, $queryRaw };
}

function rowFor(token: string, overrides: Partial<Row> = {}): Row {
  return {
    id: `row-${token}`,
    userId: USER.id,
    familyId: FAMILY,
    familyExpiresAt: new Date(Date.now() + 3_600_000),
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    rotated: false,
    ...overrides,
  };
}

const rotatedAgo = (sec: number) => ({
  revokedAt: new Date(Date.now() - sec * 1000),
  rotated: true,
});

describe('SessionsService', () => {
  it('starts a family on sign-in and stores only the hash of the token', async () => {
    const rows: Row[] = [];
    const { prisma, $queryRaw } = fakePrisma(rows);
    const issued = await new SessionsService(prisma).create(USER.id, PASSWORD_HASH);
    expect($queryRaw).toHaveBeenCalled();

    expect(issued.token).toMatch(/^[\w-]{43}$/);
    expect(rows[0]?.tokenHash).toBe(hashRefreshToken(issued.token));
    expect(rows[0]?.tokenHash).not.toContain(issued.token);
    expect(rows[0]?.familyId).toMatch(/^[0-9a-f-]{36}$/);
    const now = Date.now();
    expect(issued.expiresAt.getTime() - now).toBeGreaterThan((REFRESH_TOKEN_TTL_SEC - 5) * 1000);
    expect((rows[0]?.familyExpiresAt.getTime() ?? 0) - now).toBeGreaterThan(
      (REFRESH_FAMILY_MAX_AGE_SEC - 5) * 1000,
    );
  });

  it('starts no family when the password changed after it was verified', async () => {
    const rows: Row[] = [];
    const { prisma } = fakePrisma(rows, '$argon2id$v=19$changed');
    await expect(new SessionsService(prisma).create(USER.id, PASSWORD_HASH)).rejects.toThrow(
      'Invalid email or password',
    );
    expect(rows).toEqual([]);
  });

  it('rotates a valid token within its family, under the user lock', async () => {
    const rows = [rowFor('old')];
    const { prisma, $queryRaw } = fakePrisma(rows);
    const { user, session } = await new SessionsService(prisma).rotate('old');

    expect(user).toEqual(USER);
    expect(session.token).not.toBe('old');
    expect(rows[0]).toMatchObject({ rotated: true, revokedAt: expect.any(Date) as Date });
    expect(rows[1]).toMatchObject({
      tokenHash: hashRefreshToken(session.token),
      familyId: FAMILY,
      familyExpiresAt: rows[0]?.familyExpiresAt,
      revokedAt: null,
    });
    expect($queryRaw).toHaveBeenCalled();
  });

  it('never extends a session past the end of its family', async () => {
    const familyExpiresAt = new Date(Date.now() + 60_000);
    const { prisma } = fakePrisma([rowFor('old', { familyExpiresAt })]);
    const { session } = await new SessionsService(prisma).rotate('old');
    expect(session.expiresAt).toEqual(familyExpiresAt);
  });

  it('refuses an unknown or expired token', async () => {
    const { prisma } = fakePrisma([rowFor('old', { expiresAt: new Date(Date.now() - 1) })]);
    const service = new SessionsService(prisma);
    await expect(service.rotate('unknown')).rejects.toThrow(UnauthorizedException);
    await expect(service.rotate('old')).rejects.toThrow('Invalid or expired session');
  });

  it('refuses a token revoked by logout without touching other families', async () => {
    const rows = [
      rowFor('old', { revokedAt: new Date() }),
      rowFor('other', { familyId: OTHER_FAMILY }),
    ];
    const { prisma } = fakePrisma(rows);
    await expect(new SessionsService(prisma).rotate('old')).rejects.toThrow(
      'Invalid or expired session',
    );
    expect(rows[1]?.revokedAt).toBeNull();
  });

  it('treats a token rotated seconds ago as a lost race, not a theft', async () => {
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const rows = [rowFor('old', rotatedAgo(1)), rowFor('current')];
    const { prisma } = fakePrisma(rows);
    await expect(new SessionsService(prisma).rotate('old')).rejects.toThrow(
      RefreshRaceLostException,
    );
    expect(rows[1]?.revokedAt).toBeNull();
  });

  it('ends the whole family, and only it, when an old rotated token is replayed', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const rows = [
      rowFor('stolen', rotatedAgo(REFRESH_REUSE_LEEWAY_SEC + 5)),
      rowFor('current'),
      rowFor('other device', { familyId: OTHER_FAMILY }),
    ];
    const { prisma } = fakePrisma(rows);
    await expect(new SessionsService(prisma).rotate('stolen')).rejects.toThrow(
      'Invalid or expired session',
    );
    expect(rows[1]?.revokedAt).toBeInstanceOf(Date);
    expect(rows[2]?.revokedAt).toBeNull();
    // Named in the log, so the incident can be investigated.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(USER.id));
  });

  it('retires the family of the presented token, whatever its state', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const rows = [
      rowFor('previous', rotatedAgo(1)),
      rowFor('current'),
      rowFor('other device', { familyId: OTHER_FAMILY }),
    ];
    const { prisma } = fakePrisma(rows);
    await new SessionsService(prisma).retire('previous', 'sign-in');
    expect(rows[1]?.revokedAt).toBeInstanceOf(Date);
    expect(rows[2]?.revokedAt).toBeNull();
    // Within the leeway: a client race, not a theft.
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a long-rotated token presented at logout as theft', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const rows = [rowFor('stolen', rotatedAgo(REFRESH_REUSE_LEEWAY_SEC + 5)), rowFor('current')];
    const { prisma } = fakePrisma(rows);
    await new SessionsService(prisma).retire('stolen', 'logout');
    expect(rows[1]?.revokedAt).toBeInstanceOf(Date);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(at logout)'));
  });

  it('reports a long-rotated token presented at sign-in as theft, at sign-in', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const rows = [rowFor('stolen', rotatedAgo(REFRESH_REUSE_LEEWAY_SEC + 5)), rowFor('current')];
    const { prisma } = fakePrisma(rows);
    await new SessionsService(prisma).retire('stolen', 'sign-in');
    expect(rows[1]?.revokedAt).toBeInstanceOf(Date);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(at sign-in)'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('(at logout)'));
  });

  it('ignores an unknown token at logout', async () => {
    const rows = [rowFor('mine')];
    const { prisma } = fakePrisma(rows);
    await expect(new SessionsService(prisma).retire('unknown', 'logout')).resolves.toBeUndefined();
    expect(rows[0]?.revokedAt).toBeNull();
  });

  it('ends every session of a user at once', async () => {
    const rows = [
      rowFor('one'),
      rowFor('two', { familyId: OTHER_FAMILY }),
      rowFor('someone else', { userId: '0190b6a1-0000-7000-8000-000000000002' }),
    ];
    const { prisma, $queryRaw } = fakePrisma(rows);
    await new SessionsService(prisma).revokeAll(USER.id);
    expect(rows.map((row) => row.revokedAt !== null)).toEqual([true, true, false]);
    expect($queryRaw).toHaveBeenCalled();
  });

  it('reports how many expired sessions a sweep removed, and survives a failure', async () => {
    const { prisma, session } = fakePrisma([]);
    const service = new SessionsService(prisma);
    session.deleteMany.mockResolvedValueOnce({ count: 3 });
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await expect(service.sweep()).resolves.toBe(3);

    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    session.deleteMany.mockRejectedValueOnce(new Error('database down'));
    await expect(service.sweep()).resolves.toBe(0);
    expect(warn).toHaveBeenCalledWith('Session sweep failed: database down');
  });
});

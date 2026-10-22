import { randomBytes, randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { errorSummary } from '../common/logging/error-summary.js';
import { sha256Hex } from '../common/utils/sha256.js';
import { Prisma } from '../prisma/generated/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  REFRESH_FAMILY_MAX_AGE_SEC,
  REFRESH_REUSE_LEEWAY_SEC,
  REFRESH_TOKEN_TTL_SEC,
  SESSION_SWEEP_INTERVAL_SEC,
} from './auth.constants.js';
import type { AuthUser } from './dto/auth.schemas.js';

export interface IssuedSession {
  /** The opaque refresh token; only ever sent to the client as a cookie. */
  token: string;
  expiresAt: Date;
}

/** A new session, with the account's securityVersion read under its lock: the access token carries it. */
export interface StartedSession extends IssuedSession {
  securityVersion: number;
}

// Refresh tokens are 32 random bytes. The client holds the token, the
// database only its SHA-256: a leaked table cannot be replayed, and since the
// token has full entropy a plain hash is enough (no secret, exact lookup).
export function hashRefreshToken(token: string): string {
  return sha256Hex(token);
}

const newToken = (): string => randomBytes(32).toString('base64url');
const invalidSession = (): UnauthorizedException =>
  new UnauthorizedException('Invalid or expired session');

// Sliding expiry, never past the family's absolute end.
const expiryWithin = (familyExpiresAt: Date, now: number): Date =>
  new Date(Math.min(now + REFRESH_TOKEN_TTL_SEC * 1000, familyExpiresAt.getTime()));

// Two refreshes with the same token within seconds (two tabs, a retry after a
// lost response) are a client race, not a theft: the loser is told no without
// touching the session or the cookie the winner just set.
export class RefreshRaceLostException extends UnauthorizedException {
  constructor() {
    super('Refresh token already rotated, retry with the current one');
  }
}

type Tx = Prisma.TransactionClient;

// Every session transaction takes the user's row lock, then reads again what
// it is about to change: once the lock is granted, each statement must see
// what the transaction it waited for committed. That is READ COMMITTED,
// PostgreSQL's default, pinned here: under a stricter default set on the
// database or the role (REPEATABLE READ, SERIALIZABLE), the second read would
// see the snapshot from before the wait, and a refresh that lost a race would
// fail with a serialization error (500) instead of being answered as a race.
const SESSION_TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

type RotateOutcome =
  | { user: AuthUser; securityVersion: number; session: IssuedSession }
  | { error: 'invalid' | 'race' }
  | { error: 'reuse'; userId: string };

// Sessions follow the refresh token rotation pattern with family revocation
// (OAuth 2.0 Security BCP, RFC 9700): every refresh token works once; a
// sign-in starts a family; a token presented again after its rotation is the
// signature of theft and ends its whole family. Every change to a user's
// sessions takes that user's row lock first, so rotations, logouts and
// revocations of one user never interleave.
@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionsService.name);
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly prisma: PrismaService) {}

  // Expired rows are dead weight: swept at boot, then on an interval that
  // never keeps the process alive.
  async onModuleInit(): Promise<void> {
    await this.sweep();
    this.sweepTimer = setInterval(
      () => void this.sweep(),
      SESSION_SWEEP_INTERVAL_SEC * 1000,
    ).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  // Starts a new family (a sign-in). `verifiedPasswordHash` is the hash the
  // caller checked the password against: if it changed since (a password
  // change and revokeAll ran in between), no session is created, so a sign-in
  // with the old password can never outlive the revocation.
  async create(userId: string, verifiedPasswordHash: string): Promise<StartedSession> {
    const token = newToken();
    const { expiresAt, securityVersion } = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true, securityVersion: true },
      });
      if (user?.passwordHash !== verifiedPasswordHash) {
        throw new UnauthorizedException('Invalid email or password');
      }
      const now = Date.now();
      const familyExpiresAt = new Date(now + REFRESH_FAMILY_MAX_AGE_SEC * 1000);
      const sessionExpiresAt = expiryWithin(familyExpiresAt, now);
      await tx.session.create({
        data: {
          userId,
          familyId: randomUUID(),
          familyExpiresAt,
          tokenHash: hashRefreshToken(token),
          expiresAt: sessionExpiresAt,
        },
      });
      return { expiresAt: sessionExpiresAt, securityVersion: user.securityVersion };
    }, SESSION_TRANSACTION);
    return { token, expiresAt, securityVersion };
  }

  // Single use: a valid token is revoked as rotated and replaced by a successor
  // in the same family. A token rotated within the leeway is a client race;
  // one rotated earlier means someone else holds a copy, and its family ends.
  async rotate(
    token: string,
  ): Promise<{ user: AuthUser; securityVersion: number; session: IssuedSession }> {
    const tokenHash = hashRefreshToken(token);
    const outcome = await this.prisma.$transaction(async (tx): Promise<RotateOutcome> => {
      const found = await tx.session.findUnique({ where: { tokenHash }, select: { userId: true } });
      if (!found) return { error: 'invalid' };
      await lockUser(tx, found.userId);
      // Re-read under the lock: logout or another rotation may have changed it.
      const current = await tx.session.findUnique({
        where: { tokenHash },
        include: {
          user: {
            select: { id: true, email: true, name: true, role: true, securityVersion: true },
          },
        },
      });
      if (!current) return { error: 'invalid' };

      const now = Date.now();
      if (current.revokedAt) {
        // Revoked by a logout or a theft response: dead, nothing to learn.
        if (!current.rotated) return { error: 'invalid' };
        if (now - current.revokedAt.getTime() <= REFRESH_REUSE_LEEWAY_SEC * 1000) {
          return { error: 'race' };
        }
        await revokeFamily(tx, current.familyId, now);
        // Returned, not thrown, so the transaction commits the revocation.
        return { error: 'reuse', userId: current.userId };
      }
      if (current.expiresAt.getTime() <= now) return { error: 'invalid' };

      await tx.session.update({
        where: { id: current.id },
        data: { revokedAt: new Date(now), rotated: true },
      });
      const next = newToken();
      const expiresAt = expiryWithin(current.familyExpiresAt, now);
      await tx.session.create({
        data: {
          userId: current.userId,
          familyId: current.familyId,
          familyExpiresAt: current.familyExpiresAt,
          tokenHash: hashRefreshToken(next),
          expiresAt,
        },
      });
      const { securityVersion, ...user } = current.user;
      return { user, securityVersion, session: { token: next, expiresAt } };
    }, SESSION_TRANSACTION);

    if ('error' in outcome) {
      if (outcome.error === 'race') {
        this.logger.debug('Refresh race lost: the token was rotated moments ago');
        throw new RefreshRaceLostException();
      }
      if (outcome.error === 'reuse') this.logReuse(outcome.userId, 'refresh');
      throw invalidSession();
    }
    return outcome;
  }

  // Logout, and sign-in over an existing session: ends the family of the
  // presented token, whatever its state. Presenting a token that was rotated
  // earlier than the leeway is also reported as theft, naming where it was
  // caught. Idempotent; an unknown token is a no-op.
  async retire(token: string, during: 'sign-in' | 'logout'): Promise<void> {
    const tokenHash = hashRefreshToken(token);
    const reusedBy = await this.prisma.$transaction(async (tx) => {
      const found = await tx.session.findUnique({ where: { tokenHash }, select: { userId: true } });
      if (!found) return null;
      await lockUser(tx, found.userId);
      const current = await tx.session.findUnique({ where: { tokenHash } });
      if (!current) return null;
      const now = Date.now();
      await revokeFamily(tx, current.familyId, now);
      const reused =
        current.rotated &&
        current.revokedAt !== null &&
        now - current.revokedAt.getTime() > REFRESH_REUSE_LEEWAY_SEC * 1000;
      return reused ? current.userId : null;
    }, SESSION_TRANSACTION);
    if (reusedBy !== null) this.logReuse(reusedBy, during);
  }

  /** Ends every session of a user at once (password change, account lock). */
  async revokeAll(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }, SESSION_TRANSACTION);
  }

  /** Deletes rows past their own expiry; revoked ones are kept until then. */
  async sweep(now: number = Date.now()): Promise<number> {
    try {
      const { count } = await this.prisma.session.deleteMany({
        where: { expiresAt: { lt: new Date(now) } },
      });
      if (count > 0) this.logger.log(`Swept ${count} expired sessions`);
      return count;
    } catch (error) {
      this.logger.warn(`Session sweep failed: ${errorSummary(error)}`);
      return 0;
    }
  }

  private logReuse(userId: string, during: 'refresh' | 'sign-in' | 'logout'): void {
    this.logger.warn(
      `Refresh token reuse for user ${userId} (at ${during}): its session family was revoked`,
    );
  }
}

// Serializes every session change of one user (see the class comment), and
// every account change (a new password, a reset): they lock the same row.
// Exported for those, which revoke sessions in their own transaction.
export async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
}

/** Ends every session of a user, inside a transaction that holds the user's lock. */
export async function revokeSessionsLocked(
  tx: Tx,
  userId: string,
  now = Date.now(),
): Promise<void> {
  await tx.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(now) },
  });
}

async function revokeFamily(tx: Tx, familyId: string, now: number): Promise<void> {
  await tx.session.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(now) },
  });
}

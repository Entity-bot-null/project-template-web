import { randomBytes } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { sha256Hex } from '../common/utils/sha256.js';
import type { AccountTokenPurpose, Prisma } from '../prisma/generated/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SIGN_UP_TTL_MS } from './auth.constants.js';

// One-time tokens sent in emailed links (docs/security.md#one-time-tokens):
// 32 random bytes (256 bits) in base64url. The database keeps only the token's
// SHA-256 (a token has full entropy, so a plain hash is enough: no secret, an
// exact lookup); the token itself exists in the message on its way and in the
// link its owner opens, nowhere else. Minted when the message is sent (the
// outbox renders it then, templates/*.template.ts), so a message that is never
// sent leaves no working token behind.

type Tx = Prisma.TransactionClient;

export function hashAccountToken(token: string): string {
  return sha256Hex(token);
}

/** A new token: 32 random bytes, base64url (43 characters). Store only hashAccountToken(token). */
export function newAccountToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface MintInput {
  userId: string;
  purpose: AccountTokenPurpose;
  /** The account's securityVersion now: a later credential change makes the token stale. */
  securityVersion: number;
  /** The address the link goes to: a later change of email makes the token stale. */
  email: string;
  ttlMs: number;
}

/**
 * Mints a token, and deletes the account's unused tokens of the same purpose
 * first: at most one link of a kind works at a time, the latest.
 */
export async function mintAccountToken(
  tx: Tx,
  input: MintInput,
  now = Date.now(),
): Promise<string> {
  await tx.accountToken.deleteMany({
    where: { userId: input.userId, purpose: input.purpose, usedAt: null },
  });
  const token = newAccountToken();
  await tx.accountToken.create({
    data: {
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: hashAccountToken(token),
      securityVersion: input.securityVersion,
      email: input.email,
      expiresAt: new Date(now + input.ttlMs),
      createdAt: new Date(now),
    },
  });
  return token;
}

export interface UsableToken {
  id: string;
  userId: string;
}

/**
 * Takes a token for good, inside a transaction that already holds the
 * account's lock (lockUser): its row is locked and checked (purpose, unused,
 * unexpired, the account as it was when the token was minted), then marked
 * used. Two requests with one token: the second waits for the first's lock,
 * then finds it used. Undefined for any token that does not work, without
 * saying why (an attacker learns nothing from the answer).
 */
export async function consumeAccountToken(
  tx: Tx,
  token: string,
  purpose: AccountTokenPurpose,
  account: { id: string; email: string; securityVersion: number },
  now = Date.now(),
): Promise<UsableToken | undefined> {
  const rows = await tx.$queryRaw<
    { id: string; userId: string; securityVersion: number; email: string; expiresAt: Date }[]
  >`
    SELECT "id", "user_id" AS "userId", "security_version" AS "securityVersion", "email",
           "expires_at" AS "expiresAt"
    FROM "account_tokens"
    WHERE "token_hash" = ${hashAccountToken(token)}
      AND "purpose" = ${purpose}::"AccountTokenPurpose"
      AND "used_at" IS NULL
    FOR UPDATE`;
  const row = rows[0];
  if (
    row?.userId !== account.id ||
    row.expiresAt.getTime() <= now ||
    row.securityVersion !== account.securityVersion ||
    row.email !== account.email
  ) {
    return undefined;
  }
  const { count } = await tx.accountToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date(now) },
  });
  return count === 1 ? { id: row.id, userId: row.userId } : undefined;
}

/** Whose account a token claims to be for (unchecked): the account to lock before consuming it. */
export async function tokenOwner(tx: Tx, token: string): Promise<string | undefined> {
  const row = await tx.accountToken.findUnique({
    where: { tokenHash: hashAccountToken(token) },
    select: { userId: true },
  });
  return row?.userId;
}

const DAY_MS = 86_400_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;

// Used and expired tokens no longer work, whatever is kept: they are deleted a
// day later (the hash is useless by then; the day leaves a trace for an
// investigation of the moments around it). Swept at boot, then every hour on
// a timer that never keeps the process alive.
@Injectable()
export class AccountTokenSweep implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountTokenSweep.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async sweep(now: number = Date.now()): Promise<number> {
    try {
      const before = new Date(now - DAY_MS);
      const { count } = await this.prisma.accountToken.deleteMany({
        where: { OR: [{ expiresAt: { lt: before } }, { usedAt: { lt: before } }] },
      });
      // Sign-ups whose link expired, and those whose message never went out
      // (its queue validity is SIGN_UP_TTL_MS): nobody can finish them.
      const signUps = await this.prisma.signUp.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: before } },
            { expiresAt: null, createdAt: { lt: new Date(now - SIGN_UP_TTL_MS - DAY_MS) } },
          ],
        },
      });
      if (count > 0) this.logger.log(`Swept ${String(count)} used or expired account tokens`);
      if (signUps.count > 0) {
        this.logger.log(`Swept ${String(signUps.count)} expired sign-ups`);
      }
      return count + signUps.count;
    } catch (error) {
      this.logger.warn(
        `Account token sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }
}

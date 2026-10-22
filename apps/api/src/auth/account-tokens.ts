import { randomBytes } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { errorSummary } from '../common/logging/error-summary.js';
import { sha256Hex } from '../common/utils/sha256.js';
import type { AccountTokenPurpose, Prisma } from '../prisma/generated/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { INVITATION_MESSAGE_TTL_MS, SIGN_UP_TTL_MS } from './auth.constants.js';
import { lockUser } from './sessions.service.js';

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
  /**
   * The account's securityVersion now: a later credential change makes the
   * token stale. email_revert: the securityVersion right after the change it
   * undoes, which ranks the undo links (consumeAccountToken).
   */
  securityVersion: number;
  /** The account's address now: a later change of email makes the token stale. */
  email: string;
  /** email_change: the new address; email_revert: the address to put back. */
  targetEmail?: string;
  ttlMs: number;
  /**
   * Delete the account's earlier unused tokens of the purpose (default): at
   * most one link of a kind works, the latest. False for email_revert: a
   * later change of email must not void the link that undoes an earlier one.
   */
  replaceEarlier?: boolean;
}

/**
 * Mints a token, and deletes the account's unused tokens of the same purpose
 * first: at most one link of a kind works at a time, the latest. Takes the
 * account's lock first, like every flow that uses a token (the account's
 * row, then its tokens): otherwise this transaction, holding a token row,
 * could wait on the account row (the foreign key's check) while a flow
 * holding the account row waits on that token, and PostgreSQL would abort
 * one of them as a deadlock.
 */
export async function mintAccountToken(
  tx: Tx,
  input: MintInput,
  now = Date.now(),
): Promise<string> {
  await lockUser(tx, input.userId);
  if (input.replaceEarlier !== false) {
    await tx.accountToken.deleteMany({
      where: { userId: input.userId, purpose: input.purpose, usedAt: null },
    });
  }
  const token = newAccountToken();
  await tx.accountToken.create({
    data: {
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: hashAccountToken(token),
      securityVersion: input.securityVersion,
      email: input.email,
      targetEmail: input.targetEmail ?? null,
      expiresAt: new Date(now + input.ttlMs),
      createdAt: new Date(now),
    },
  });
  return token;
}

export interface UsableToken {
  id: string;
  userId: string;
  /** email_change: the new address; email_revert: the address to put back. */
  targetEmail: string | null;
  /**
   * The securityVersion it was minted for. email_revert: the account's right
   * after the change it undoes, so an undo link outranks those of later
   * changes, whenever their messages went out.
   */
  securityVersion: number;
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
  /**
   * The account must still be as it was when the token was minted (same
   * securityVersion and email): true by default. False for email_revert,
   * which undoes a change whatever happened to the account after it.
   */
  boundToState = true,
): Promise<UsableToken | undefined> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      userId: string;
      securityVersion: number;
      email: string;
      targetEmail: string | null;
      expiresAt: Date;
    }[]
  >`
    SELECT "id", "user_id" AS "userId", "security_version" AS "securityVersion", "email",
           "target_email" AS "targetEmail", "expires_at" AS "expiresAt"
    FROM "account_tokens"
    WHERE "token_hash" = ${hashAccountToken(token)}
      AND "purpose" = ${purpose}::"AccountTokenPurpose"
      AND "used_at" IS NULL
    FOR UPDATE`;
  const row = rows[0];
  if (row?.userId !== account.id || row.expiresAt.getTime() <= now) return undefined;
  if (
    boundToState &&
    (row.securityVersion !== account.securityVersion || row.email !== account.email)
  ) {
    return undefined;
  }
  const { count } = await tx.accountToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date(now) },
  });
  return count === 1
    ? {
        id: row.id,
        userId: row.userId,
        targetEmail: row.targetEmail,
        securityVersion: row.securityVersion,
      }
    : undefined;
}

/** Whose account a token claims to be for (unchecked): the account to lock before consuming it. */
export async function tokenOwner(
  tx: Tx,
  token: string,
  purpose: AccountTokenPurpose,
  now = Date.now(),
): Promise<string | undefined> {
  const row = await tx.accountToken.findUnique({
    where: { tokenHash: hashAccountToken(token) },
    select: { userId: true, purpose: true, usedAt: true, expiresAt: true },
  });
  // Only a token that can still work: a used, expired or other-purpose one
  // goes no further (no password check against its account, no hashing).
  if (row?.purpose !== purpose || row.usedAt !== null || row.expiresAt.getTime() <= now) {
    return undefined;
  }
  return row.userId;
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
      // Invitations likewise.
      const invitations = await this.prisma.invitation.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: before } },
            {
              expiresAt: null,
              createdAt: { lt: new Date(now - INVITATION_MESSAGE_TTL_MS - DAY_MS) },
            },
          ],
        },
      });
      if (count > 0) this.logger.log(`Swept ${String(count)} used or expired account tokens`);
      if (signUps.count > 0) {
        this.logger.log(`Swept ${String(signUps.count)} expired sign-ups`);
      }
      if (invitations.count > 0) {
        this.logger.log(`Swept ${String(invitations.count)} expired invitations`);
      }
      return count + signUps.count + invitations.count;
    } catch (error) {
      this.logger.warn(`Account token sweep failed: ${errorSummary(error)}`);
      return 0;
    }
  }
}

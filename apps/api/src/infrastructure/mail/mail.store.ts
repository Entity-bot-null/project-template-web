import { Injectable } from '@nestjs/common';
import type { MailKind, Prisma } from '../../prisma/generated/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  MAIL_FAILED_ADDRESS_RETENTION_DAYS,
  MAIL_LEASE_MS,
  MAIL_RETENTION_DAYS,
} from './mail.constants.js';
import type { ClaimedMessage } from './mail.types.js';

const DAY_MS = 86_400_000;

export interface OutboxStats {
  /** Messages still to send: pending, or being sent. */
  waiting: number;
  /** Age of the oldest of them, 0 when there is none. */
  oldestAgeSeconds: number;
}

/** The claim a transition was made under: only that claim may finish the message. */
type Claim = Pick<ClaimedMessage, 'id' | 'attempts'>;

// Every read and write of the outbox's delivery state (the queueing side is
// MailOutboxService.enqueue, in the caller's transaction). A claim is one
// atomic statement; every transition after it is fenced by the claim it was
// made under (status sending, same attempt): a worker whose lease ran out and
// whose message another worker took over can no longer finish it.
@Injectable()
export class MailStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Takes the next due message, or one whose worker's lease ran out, and
   * leases it to this worker: one statement, so two workers (in one process
   * or in several) never take the same message; SKIP LOCKED lets each pass
   * over the row another is taking. The attempt is counted here, before the
   * send: a message that crashes its worker every time still runs out of
   * attempts.
   */
  async claim(leaseMs: number = MAIL_LEASE_MS): Promise<ClaimedMessage | undefined> {
    const rows = await this.prisma.$queryRaw<ClaimedMessage[]>`
      UPDATE "mail_messages"
      SET "status" = 'sending',
          "attempts" = "attempts" + 1,
          "locked_until" = now() + make_interval(secs => ${leaseMs / 1000}::double precision),
          "updated_at" = now()
      WHERE "id" = (
        SELECT "id" FROM "mail_messages"
        WHERE ("status" = 'pending' AND "next_attempt_at" <= now())
           OR ("status" = 'sending' AND "locked_until" < now())
        ORDER BY "next_attempt_at", "id"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "kind", "recipient", "user_id" AS "userId", "payload", "attempts",
                "expires_at" AS "expiresAt", "created_at" AS "createdAt", "request_id" AS "requestId"`;
    return rows[0];
  }

  /** Runs a template's work in a short transaction of its own (never around the SMTP exchange). */
  inTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work, { timeout: 10_000 });
  }

  /** The server accepted it: the address goes, only its hash stays. */
  async markSent(claim: Claim): Promise<boolean> {
    return this.finish(claim, {
      status: 'sent',
      sentAt: new Date(),
      recipient: null,
      lockedUntil: null,
      lastError: null,
    });
  }

  /** Back to pending, for another attempt after `delayMs`. */
  async reschedule(claim: Claim, delayMs: number, category: string): Promise<boolean> {
    return this.finish(claim, {
      status: 'pending',
      nextAttemptAt: new Date(Date.now() + delayMs),
      lockedUntil: null,
      lastError: category,
    });
  }

  /** Given up: kept, with its address, for inspection and a manual retry. */
  async markFailed(claim: Claim, category: string): Promise<boolean> {
    return this.finish(claim, { status: 'failed', lockedUntil: null, lastError: category });
  }

  /** Dropped unsent (too late, or no longer applies): the address goes. */
  async markExpired(claim: Claim, reason: string): Promise<boolean> {
    return this.finish(claim, {
      status: 'expired',
      recipient: null,
      lockedUntil: null,
      lastError: reason,
    });
  }

  async stats(): Promise<OutboxStats> {
    const { _count, _min } = await this.prisma.mailMessage.aggregate({
      where: { status: { in: ['pending', 'sending'] } },
      _count: { _all: true },
      _min: { createdAt: true },
    });
    const oldest = _min.createdAt;
    return {
      waiting: _count._all,
      oldestAgeSeconds: oldest === null ? 0 : Math.max(0, (Date.now() - oldest.getTime()) / 1000),
    };
  }

  /**
   * Retention (docs/architecture.md#email): finished rows go after
   * MAIL_RETENTION_DAYS; a failed message's address is cleared after
   * MAIL_FAILED_ADDRESS_RETENTION_DAYS, when retrying it no longer makes sense.
   */
  async sweep(now: number = Date.now()): Promise<{ deleted: number; cleared: number }> {
    const { count: deleted } = await this.prisma.mailMessage.deleteMany({
      where: {
        status: { in: ['sent', 'expired', 'failed'] },
        createdAt: { lt: new Date(now - MAIL_RETENTION_DAYS * DAY_MS) },
      },
    });
    const { count: cleared } = await this.prisma.mailMessage.updateMany({
      where: {
        status: 'failed',
        recipient: { not: null },
        updatedAt: { lt: new Date(now - MAIL_FAILED_ADDRESS_RETENTION_DAYS * DAY_MS) },
      },
      data: { recipient: null },
    });
    return { deleted, cleared };
  }

  /**
   * Puts failed messages back in the queue, with their attempts counted from
   * zero: one by id, or every failed one (of a kind). Only those that still
   * have their address (retention clears it after a week).
   */
  async retryFailed(filter: { id?: string; kind?: MailKind }): Promise<number> {
    const { count } = await this.prisma.mailMessage.updateMany({
      where: {
        status: 'failed',
        recipient: { not: null },
        ...(filter.id === undefined ? {} : { id: filter.id }),
        ...(filter.kind === undefined ? {} : { kind: filter.kind }),
      },
      data: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    return count;
  }

  private async finish(claim: Claim, data: Prisma.MailMessageUpdateManyMutationInput) {
    const { count } = await this.prisma.mailMessage.updateMany({
      where: { id: claim.id, status: 'sending', attempts: claim.attempts },
      data,
    });
    return count === 1;
  }
}

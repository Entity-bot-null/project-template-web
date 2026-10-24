import { Inject, Injectable } from '@nestjs/common';
import { type MailKind, Prisma } from '../../prisma/generated/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  MAIL_FAILED_ADDRESS_RETENTION_DAYS,
  MAIL_LEASE_MS,
  MAIL_RETENTION_DAYS,
  MAIL_TEMPLATES,
  DROPPED_WHILE_HELD,
} from './mail.constants.js';
import type { ClaimedMessage } from './mail.types.js';
import type { MailTemplates } from './templates/registry.js';

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OutboxStats {
  /** Messages still to send: pending, or being sent. */
  waiting: number;
  /** Age of the oldest of them, 0 when there is none. */
  oldestAgeSeconds: number;
}

/** The claim a transition was made under: only that claim may finish the message. */
type Claim = Pick<ClaimedMessage, 'id' | 'attempts' | 'claimId'>;

// Every read and write of the outbox's delivery state (the queueing side is
// MailOutboxService.enqueue, in the caller's transaction). A claim is one
// atomic statement; every transition after it is fenced by the claim it was
// made under (status sending, same attempt, same claim id): a worker whose
// lease ran out and whose message another worker took over can no longer
// finish it. The id is new at each claim, so a manual retry that starts the
// attempts again never revives an old claim. The previous release (a
// deployment, a rollback) fences by the attempt alone and leaves the id as it
// is: a manual retry clears it, so that release's next claims carry none, and
// no claim of this one matches them whatever the attempt.
@Injectable()
export class MailStore {
  /** The kinds nobody can request (security notices): claimed before the others. */
  private readonly urgentKinds: MailKind[];

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAIL_TEMPLATES) private readonly templates: MailTemplates,
  ) {
    this.urgentKinds = (Object.keys(templates) as MailKind[]).filter(
      (kind) => !templates[kind].limited,
    );
  }

  /**
   * Takes the next due message, or one whose worker's lease ran out, and
   * leases it to this worker: one statement, so two workers (in one process
   * or in several) never take the same message; SKIP LOCKED lets each pass
   * over the row another is taking. The attempt is counted here, before the
   * send: a message that crashes its worker every time still runs out of
   * attempts. The claim id is new: what this worker records is fenced by it.
   */
  async claim(leaseMs: number = MAIL_LEASE_MS): Promise<ClaimedMessage | undefined> {
    const rows = await this.prisma.$queryRaw<ClaimedMessage[]>`
      UPDATE "mail_messages"
      SET "status" = 'sending',
          "attempts" = "attempts" + 1,
          "claim_id" = gen_random_uuid(),
          "locked_until" = now() + make_interval(secs => ${leaseMs / 1000}::double precision),
          "updated_at" = now()
      WHERE "id" = (
        SELECT "id" FROM "mail_messages"
        WHERE ("status" = 'pending' AND "next_attempt_at" <= now())
           OR ("status" = 'sending' AND "locked_until" < now())
        -- Security notices first: a flood of messages anyone can ask for
        -- never delays a "your password was changed".
        ORDER BY ("kind"::text = ANY(${this.urgentKinds}::text[])) DESC, "next_attempt_at", "id"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "kind", "recipient", "user_id" AS "userId", "payload", "attempts",
                "claim_id" AS "claimId", "expires_at" AS "expiresAt",
                "created_at" AS "createdAt", "request_id" AS "requestId"`;
    return rows[0];
  }

  /** Runs a template's work in a short transaction of its own (never around the SMTP exchange). */
  inTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    // READ COMMITTED whatever the database's default, like the session and
    // account transactions: a template that waits for the account's lock
    // (email-changed.template.ts) must then read what the transaction it
    // waited for committed, not fail with a serialization error.
    return this.prisma.$transaction(work, {
      timeout: 10_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  /**
   * Extends the lease of a message this worker is still sending, by the
   * database's clock like the claim. False once the claim is no longer held
   * (another worker took the message over after a pause longer than the lease).
   */
  async renewLease(claim: Claim, leaseMs: number = MAIL_LEASE_MS): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE "mail_messages"
      SET "locked_until" = now() + make_interval(secs => ${leaseMs / 1000}::double precision),
          "updated_at" = now()
      WHERE "id" = ${claim.id}::uuid AND "status" = 'sending' AND "attempts" = ${claim.attempts}
        AND "claim_id" = ${claim.claimId}::uuid`;
    return count === 1;
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

  /**
   * What became of a message whose claim refused a transition (finish):
   * `dropped`, under this very claim, by a caller that left its outcome to
   * this worker (expireQueued, DROPPED_WHILE_HELD); `counted`, under it, by
   * a caller that counted it (the lease had run out); `taken-over`, another
   * worker's claim since; `gone`, its account was deleted with it.
   */
  async fateOf(claim: Claim): Promise<'dropped' | 'counted' | 'taken-over' | 'gone'> {
    const row = await this.prisma.mailMessage.findUnique({
      where: { id: claim.id },
      select: { status: true, attempts: true, claimId: true, lastError: true },
    });
    if (row === null) return 'gone';
    const same = row.attempts === claim.attempts && row.claimId === claim.claimId;
    if (row.status !== 'expired' || !same) return 'taken-over';
    return row.lastError?.endsWith(DROPPED_WHILE_HELD) === true ? 'dropped' : 'counted';
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
  async sweep(
    now: number = Date.now(),
  ): Promise<{ deleted: number; cleared: number; expired: number }> {
    // Pending messages a day past their validity: no worker sent them (email
    // was turned off since, say). Dropped, and their address cleared, like
    // the ones a worker finds expired.
    const { count: expired } = await this.prisma.mailMessage.updateMany({
      where: { status: 'pending', expiresAt: { lt: new Date(now - DAY_MS) } },
      data: { status: 'expired', recipient: null },
    });
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
    return { deleted, cleared, expired };
  }

  /**
   * Puts failed messages back in the queue, their attempts started again and
   * their last claim's id cleared (the claim id fences each claim, not the
   * attempt alone: see the class comment) and with a new validity
   * (their kind's), else one that failed through an outage longer than that
   * would be dropped unsent at once: one by id, or
   * every failed one (of a kind). Only those that still have their address
   * (retention clears it after a week). A link's own validity starts when it
   * is sent, so a late message never carries a long-lived token. The rows are
   * locked in id order, like expireQueued's: the two never deadlock.
   */
  async retryFailed(
    filter: { id?: string; kind?: MailKind },
    now: number = Date.now(),
  ): Promise<number> {
    // An id that is no message's (a typo on the command line) matches nothing.
    if (filter.id !== undefined && !UUID.test(filter.id)) return 0;
    const id = filter.id ?? null;
    let queued = 0;
    for (const kind of Object.keys(this.templates) as MailKind[]) {
      if (filter.kind !== undefined && filter.kind !== kind) continue;
      queued += await this.prisma.$executeRaw`
        UPDATE "mail_messages" AS "message"
        SET "status" = 'pending', "attempts" = 0, "claim_id" = NULL,
            "next_attempt_at" = ${new Date(now)},
            "expires_at" = ${new Date(now + this.templates[kind].ttlMs)},
            "last_error" = NULL, "updated_at" = now()
        FROM (
          SELECT "id" FROM "mail_messages"
          WHERE "status" = 'failed' AND "recipient" IS NOT NULL AND "kind" = ${kind}::"MailKind"
            AND (${id}::uuid IS NULL OR "id" = ${id}::uuid)
          ORDER BY "id"
          FOR UPDATE
        ) AS "due"
        WHERE "message"."id" = "due"."id"`;
    }
    return queued;
  }

  private async finish(claim: Claim, data: Prisma.MailMessageUpdateManyMutationInput) {
    const { count } = await this.prisma.mailMessage.updateMany({
      where: { id: claim.id, status: 'sending', attempts: claim.attempts, claimId: claim.claimId },
      data,
    });
    return count === 1;
  }
}

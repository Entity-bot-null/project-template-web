import { Inject, Injectable } from '@nestjs/common';
import type { MailKind, Prisma } from '../../prisma/generated/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  MAIL_FAILED_ADDRESS_RETENTION_DAYS,
  MAIL_LEASE_MS,
  MAIL_RETENTION_DAYS,
  MAIL_TEMPLATES,
} from './mail.constants.js';
import type { ClaimedMessage } from './mail.types.js';
import type { MailTemplates } from './templates/registry.js';

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
        -- Security notices first: a flood of messages anyone can ask for
        -- never delays a "your password was changed".
        ORDER BY ("kind"::text = ANY(${this.urgentKinds}::text[])) DESC, "next_attempt_at", "id"
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
      WHERE "id" = ${claim.id}::uuid AND "status" = 'sending' AND "attempts" = ${claim.attempts}`;
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
   * Puts failed messages back in the queue, with their attempts counted from
   * zero and a new validity (their kind's), else one that failed through an
   * outage longer than that would be dropped unsent at once: one by id, or
   * every failed one (of a kind). Only those that still have their address
   * (retention clears it after a week). A link's own validity starts when it
   * is sent, so a late message never carries a long-lived token.
   */
  async retryFailed(
    filter: { id?: string; kind?: MailKind },
    now: number = Date.now(),
  ): Promise<number> {
    let queued = 0;
    for (const kind of Object.keys(this.templates) as MailKind[]) {
      if (filter.kind !== undefined && filter.kind !== kind) continue;
      const { count } = await this.prisma.mailMessage.updateMany({
        where: {
          status: 'failed',
          recipient: { not: null },
          kind,
          ...(filter.id === undefined ? {} : { id: filter.id }),
        },
        data: {
          status: 'pending',
          attempts: 0,
          nextAttemptAt: new Date(now),
          expiresAt: new Date(now + this.templates[kind].ttlMs),
          lastError: null,
        },
      });
      queued += count;
    }
    return queued;
  }

  private async finish(claim: Claim, data: Prisma.MailMessageUpdateManyMutationInput) {
    const { count } = await this.prisma.mailMessage.updateMany({
      where: { id: claim.id, status: 'sending', attempts: claim.attempts },
      data,
    });
    return count === 1;
  }
}

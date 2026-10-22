import { Inject, Injectable, Logger } from '@nestjs/common';
import { normalizeEmail } from '../../auth/auth.constants.js';
import type { MailKind, Prisma } from '../../prisma/generated/client.js';
import { recordMailDelivery, recordMailSuppressed } from '../../observability/metrics.js';
import { currentRequestId } from '../../observability/request-context.js';
import {
  DROPPED_WHILE_HELD,
  MAIL_OPTIONS,
  MAIL_PER_ADDRESS_PER_MINUTE,
  MAIL_TEMPLATES,
} from './mail.constants.js';
import { recipientHash } from './mail.recipient.js';
import type { MailOptions } from './mail.types.js';
import type { MailTemplates } from './templates/registry.js';

export interface EnqueueInput {
  kind: MailKind;
  /** The address, normalized here like account emails (normalizeEmail). */
  to: string;
  /** The account the message is about, if any. */
  userId?: string;
  /** Ids the template needs: never a secret, a token, an address or a body. */
  payload?: Record<string, string>;
  /** Makes a second enqueue of the same message a no-op (a retried request). */
  dedupeKey?: string;
  /** The request's id, to follow the message through the logs (default: the current request's). */
  requestId?: string;
}

/**
 * queued: will be sent once the caller's transaction commits.
 * duplicate: a message with this dedupeKey exists; nothing added.
 * suppressed: the address got its share of messages (per-address limits).
 * disabled: email is off (MAIL_SMTP_URL unset); nothing is queued.
 */
export type EnqueueResult = 'queued' | 'duplicate' | 'suppressed' | 'disabled';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// The queueing side of the outbox: a business change and the message it calls
// for are written in one transaction (the caller's), so the message exists if
// and only if the change was committed. Delivery is MailWorker's.
@Injectable()
export class MailOutboxService {
  private readonly logger = new Logger('Mail');
  private readonly limitedKinds: MailKind[];
  private queuedListener: (() => void) | undefined;

  constructor(
    @Inject(MAIL_OPTIONS) private readonly options: MailOptions,
    @Inject(MAIL_TEMPLATES) private readonly templates: MailTemplates,
  ) {
    this.limitedKinds = (Object.keys(templates) as MailKind[]).filter(
      (kind) => templates[kind].limited,
    );
  }

  /** Email is configured (MAIL_SMTP_URL); without it nothing is queued. */
  get enabled(): boolean {
    return this.options.smtpUrl !== undefined;
  }

  /**
   * Queues a message inside the caller's transaction. Messages anyone can
   * request (the template's `limited`) are held back past one a minute and
   * MAIL_DAILY_LIMIT_PER_ADDRESS a day per address, counted in the database
   * so every instance shares the limits; the address's advisory lock makes
   * concurrent requests for one address count one after the other. Answers
   * the same to the caller's own caller whatever happens here: what was
   * queued is never told to a client (no account enumeration).
   */
  async enqueue(tx: Prisma.TransactionClient, input: EnqueueInput): Promise<EnqueueResult> {
    if (!this.enabled) return 'disabled';
    const template = this.templates[input.kind];
    const to = normalizeEmail(input.to);
    const hash = recipientHash(this.options.recipientKey, to);
    const now = Date.now();

    if (template.limited) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mail-recipient:${hash}`}, 0))`;
      const recent = { recipientHash: hash, kind: { in: this.limitedKinds } };
      const [lastMinute, lastDay] = await Promise.all([
        tx.mailMessage.count({
          where: { ...recent, createdAt: { gt: new Date(now - MINUTE_MS) } },
        }),
        tx.mailMessage.count({ where: { ...recent, createdAt: { gt: new Date(now - DAY_MS) } } }),
      ]);
      if (
        lastMinute >= MAIL_PER_ADDRESS_PER_MINUTE ||
        lastDay >= this.options.dailyLimitPerAddress
      ) {
        recordMailSuppressed(input.kind);
        this.logger.warn(
          `Held back a ${input.kind} message to recipient ${hash.slice(0, 12)}: per-address limit reached`,
        );
        return 'suppressed';
      }
    }

    // ON CONFLICT DO NOTHING (skipDuplicates): a dedupeKey seen before is a
    // no-op, not a unique violation that would abort the caller's transaction.
    const { count } = await tx.mailMessage.createMany({
      data: [
        {
          kind: input.kind,
          recipient: to,
          recipientHash: hash,
          userId: input.userId ?? null,
          payload: input.payload ?? {},
          dedupeKey: input.dedupeKey ?? null,
          expiresAt: new Date(now + template.ttlMs),
          requestId: input.requestId ?? currentRequestId() ?? null,
        },
      ],
      skipDuplicates: true,
    });
    return count === 1 ? 'queued' : 'duplicate';
  }

  /**
   * Drops, unsent, the messages of a kind about an account that still wait in
   * the outbox (pending, being sent, failed), whose payload number `key` is at
   * least `from` or missing: what a later change made moot. Inside the
   * caller's transaction, like enqueue. One being composed at that moment is
   * refused by its template, which reads its row under the same lock as the
   * caller's (email-changed.template.ts); one already past composing goes out,
   * and its worker finds the row changed. The rows are locked in id order,
   * like a retry from the command line (MailStore.retryFailed): none of these
   * deadlock each other (against the sweep, which locks in its own order, the
   * caller runs once more: onceMoreOnWriteConflict). Returns how many it
   * dropped, and how many of them no worker held under a live lease: those the
   * caller reports with recordExpired once it has committed. The others are
   * marked (DROPPED_WHILE_HELD) for the worker holding them, which reports
   * their outcome (MailStore.fateOf); one that died holding it reports none.
   */
  async expireQueued(
    tx: Prisma.TransactionClient,
    input: { kind: MailKind; userId: string; key: string; from: number; reason: string },
  ): Promise<{ dropped: number; unclaimed: number }> {
    const { kind, userId, key, from, reason } = input;
    const rows = await tx.$queryRaw<{ unclaimed: boolean }[]>`
      UPDATE "mail_messages" AS "message"
      SET "status" = 'expired', "recipient" = NULL, "locked_until" = NULL,
          "last_error" = CASE WHEN "before"."unclaimed" THEN ${reason}
                              ELSE ${reason} || ${DROPPED_WHILE_HELD} END,
          "updated_at" = now()
      FROM (
        SELECT "id", ("status" <> 'sending' OR "locked_until" < now()) AS "unclaimed"
        FROM "mail_messages"
        WHERE "user_id" = ${userId}::uuid
          AND "kind" = ${kind}::"MailKind"
          AND "status" IN ('pending', 'sending', 'failed')
          AND CASE WHEN "payload"->>${key} ~ '^[0-9]{1,18}$'
                   THEN ("payload"->>${key})::bigint >= ${from}
                   ELSE true END
        ORDER BY "id"
        FOR UPDATE
      ) AS "before"
      WHERE "message"."id" = "before"."id"
      RETURNING "before"."unclaimed"`;
    return { dropped: rows.length, unclaimed: rows.filter((row) => row.unclaimed).length };
  }

  /**
   * Counts the messages a caller dropped with expireQueued that no worker
   * held, after its transaction committed (a rolled-back one dropped
   * nothing): the delivery metric then counts a dropped message at most once,
   * whoever settled it.
   */
  recordExpired(kind: MailKind, count: number): void {
    for (let i = 0; i < count; i += 1) recordMailDelivery(kind, 'expired');
  }

  /**
   * Call after the transaction that queued a message has committed: this
   * instance's worker looks at once instead of at its next poll. Best effort:
   * the poll finds the message anyway.
   */
  notifyQueued(): void {
    this.queuedListener?.();
  }

  /** The worker of this process registers here. */
  onQueued(listener: () => void): void {
    this.queuedListener = listener;
  }
}

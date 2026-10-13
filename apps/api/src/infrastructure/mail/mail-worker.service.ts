import { performance } from 'node:perf_hooks';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { errorTracker } from '../../observability/error-tracker.js';
import {
  observeMailOutbox,
  recordMailDelivery,
  recordMailLatency,
} from '../../observability/metrics.js';
import { MailOutboxService } from './mail-outbox.service.js';
import {
  MAIL_BACKLOG_DEGRADED_SEC,
  MAIL_FAILURE_DEGRADED_MS,
  MAIL_OPTIONS,
  MAIL_POLL_INTERVAL_MS,
  MAIL_SHUTDOWN_GRACE_MS,
  MAIL_STATS_INTERVAL_MS,
  MAIL_SWEEP_INTERVAL_MS,
  MAIL_TEMPLATES,
  MAIL_TRANSPORT_FACTORY,
} from './mail.constants.js';
import { MailStore, type OutboxStats } from './mail.store.js';
import type { MailTransport, MailTransportFactory } from './mail.transport.js';
import type { ClaimedMessage, MailOptions, OutgoingMail } from './mail.types.js';
import { retryDelayMs } from './retry-delay.js';
import { classifyDeliveryError, type DeliveryFailure } from './smtp-errors.js';
import { type MailTemplates, productName } from './templates/registry.js';

/** disabled: not configured. ok: delivering. degraded: deliveries failing, or a backlog. */
export type MailHealth = 'ok' | 'degraded' | 'disabled';

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Delivers the outbox (docs/architecture.md#email). Every API instance runs
// one worker; they share the queue safely (MailStore.claim). A worker takes
// one message at a time: claim it (a lease), render it (a short transaction,
// where a template may mint a link's token), send it with no transaction open,
// then record the outcome, fenced by the claim. Delivery is at least once: if
// the process dies after the server accepted a message and before the outcome
// is recorded, the lease runs out and the message is sent again.
@Injectable()
export class MailWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Mail');
  private transport: MailTransport | undefined;
  private timers: NodeJS.Timeout[] = [];
  private draining: Promise<void> | undefined;
  private wakeRequested = false;
  private stopping = false;
  private stats: OutboxStats | undefined;
  private lastDelivery: { at: number; ok: boolean } | undefined;

  constructor(
    private readonly store: MailStore,
    private readonly outbox: MailOutboxService,
    @Inject(MAIL_OPTIONS) private readonly options: MailOptions,
    @Inject(MAIL_TRANSPORT_FACTORY) private readonly createTransport: MailTransportFactory,
    @Inject(MAIL_TEMPLATES) private readonly templates: MailTemplates,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.outbox.enabled) return;
    this.transport = this.createTransport(this.options);
    this.outbox.onQueued(() => {
      this.wake();
    });
    observeMailOutbox(() => this.stats);
    // Timers never keep the process alive; each run catches its own errors.
    this.timers = [
      setInterval(() => {
        this.wake();
      }, MAIL_POLL_INTERVAL_MS).unref(),
      setInterval(() => void this.refreshStats(), MAIL_STATS_INTERVAL_MS).unref(),
      setInterval(() => void this.sweep(), MAIL_SWEEP_INTERVAL_MS).unref(),
    ];
    void this.refreshStats();
    void this.sweep();
    this.wake();
  }

  /** Stops claiming, and waits a little for the message being sent (else its lease brings it back). */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.draining !== undefined) {
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        this.draining,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, MAIL_SHUTDOWN_GRACE_MS).unref();
        }),
      ]);
      clearTimeout(timeout);
    }
    this.transport?.close();
  }

  /** What readiness reports; never fails the probe (email is optional). */
  health(now: number = Date.now()): MailHealth {
    if (!this.outbox.enabled) return 'disabled';
    const failing =
      this.lastDelivery !== undefined &&
      !this.lastDelivery.ok &&
      now - this.lastDelivery.at < MAIL_FAILURE_DEGRADED_MS;
    const backlog = (this.stats?.oldestAgeSeconds ?? 0) > MAIL_BACKLOG_DEGRADED_SEC;
    return failing || backlog ? 'degraded' : 'ok';
  }

  /** Looks for due messages now; one drain at a time, another right after if asked meanwhile. */
  wake(): void {
    if (this.stopping || this.transport === undefined) return;
    if (this.draining !== undefined) {
      this.wakeRequested = true;
      return;
    }
    this.startDrain();
  }

  /**
   * Delivers every due message now, and resolves when none is left: after
   * the drain in progress, if any. The poll and the commits wake the worker
   * on their own; this is for whoever must know the queue was worked through.
   */
  async runOnce(): Promise<void> {
    await this.idle();
    if (this.stopping || this.transport === undefined) return;
    this.startDrain();
    await this.idle();
  }

  /** Resolves when the current drain is over. */
  async idle(): Promise<void> {
    while (this.draining !== undefined) await this.draining;
  }

  private startDrain(): void {
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        this.wake();
      }
    });
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopping) {
        const claimed = await this.store.claim();
        if (claimed === undefined) return;
        await this.deliver(claimed);
      }
    } catch (error) {
      // The database is down, most likely: the next poll tries again.
      this.logger.warn(`Mail worker paused: ${message(error)}`);
    }
  }

  private async deliver(claimed: ClaimedMessage): Promise<void> {
    const label = `${claimed.kind} message ${claimed.id} (attempt ${String(claimed.attempts)})`;
    if (claimed.attempts > this.options.maxAttempts) {
      // Taken over again and again: its worker never got to record an outcome.
      await this.fail(claimed, label, 'attempts_exhausted');
      return;
    }
    if (claimed.expiresAt.getTime() <= Date.now()) {
      await this.expire(claimed, label, 'expired');
      return;
    }

    let mail: OutgoingMail | null;
    try {
      mail = await this.compose(claimed);
    } catch (error) {
      this.logger.warn(`Could not render ${label}: ${message(error)}`);
      await this.retryLater(claimed, label, {
        category: 'render',
        permanent: false,
        configuration: false,
      });
      return;
    }
    if (mail === null) {
      await this.expire(claimed, label, 'not_applicable');
      return;
    }

    const started = performance.now();
    try {
      await this.transportOrThrow().send(mail);
    } catch (error) {
      const seconds = (performance.now() - started) / 1000;
      const failure = classifyDeliveryError(error);
      // A permanent refusal is about this message (the server works); any
      // other failure is about the service, and degrades the health.
      this.lastDelivery = { at: Date.now(), ok: failure.permanent };
      if (failure.configuration) {
        errorTracker().capture(new Error(`SMTP refused the configuration (${failure.category})`), {
          level: 'error',
          origin: 'dependency',
          dependency: 'smtp',
        });
      }
      if (failure.permanent) await this.fail(claimed, label, failure.category, seconds);
      else await this.retryLater(claimed, label, failure, seconds);
      return;
    }

    const seconds = (performance.now() - started) / 1000;
    this.lastDelivery = { at: Date.now(), ok: true };
    recordMailDelivery(claimed.kind, 'sent', seconds);
    recordMailLatency(claimed.kind, (Date.now() - claimed.createdAt.getTime()) / 1000);
    if (await this.store.markSent(claimed)) {
      this.logger.log(`Sent ${label} in ${String(Math.round(seconds * 1000))} ms`);
    } else {
      this.logger.warn(
        `Sent ${label}, but its lease had run out: another worker may send it again`,
      );
    }
  }

  private async compose(claimed: ClaimedMessage): Promise<OutgoingMail | null> {
    const appOrigin = this.options.appOrigin;
    if (appOrigin === undefined) throw new Error('APP_ORIGIN is not set');
    const template = this.templates[claimed.kind];
    const product = productName(this.options);
    const rendered = await this.store.inTransaction((tx) =>
      template.compose({ tx, message: claimed, product, appOrigin }),
    );
    return rendered === null ? null : { id: claimed.id, to: claimed.recipient, ...rendered };
  }

  // Every outcome is counted here, whatever led to it (a refused send, a
  // render that failed, a worker that kept dying): the alerts read them.
  // `seconds` is the SMTP exchange, when there was one.
  private async retryLater(
    claimed: ClaimedMessage,
    label: string,
    failure: DeliveryFailure,
    seconds?: number,
  ) {
    if (claimed.attempts >= this.options.maxAttempts) {
      await this.fail(claimed, label, failure.category, seconds);
      return;
    }
    recordMailDelivery(claimed.kind, 'retry', seconds);
    const delayMs = retryDelayMs(claimed.attempts);
    await this.store.reschedule(claimed, delayMs, failure.category);
    this.logger.warn(
      `Could not send ${label}: ${failure.category}; retrying in ${String(Math.round(delayMs / 1000))} s`,
    );
  }

  private async fail(claimed: ClaimedMessage, label: string, category: string, seconds?: number) {
    recordMailDelivery(claimed.kind, 'failed', seconds);
    await this.store.markFailed(claimed, category);
    this.logger.error(
      `Gave up on ${label}: ${category}. Inspect and retry: pnpm --filter api mail status`,
    );
  }

  private async expire(claimed: ClaimedMessage, label: string, reason: string) {
    recordMailDelivery(claimed.kind, 'expired');
    await this.store.markExpired(claimed, reason);
    this.logger.warn(`Dropped ${label}: ${reason}`);
  }

  private transportOrThrow(): MailTransport {
    if (this.transport === undefined) throw new Error('Mail worker not started');
    return this.transport;
  }

  private async refreshStats(): Promise<void> {
    try {
      this.stats = await this.store.stats();
    } catch (error) {
      this.logger.warn(`Could not read the mail queue: ${message(error)}`);
    }
  }

  private async sweep(): Promise<void> {
    try {
      const { deleted, cleared } = await this.store.sweep();
      if (deleted + cleared > 0) {
        this.logger.log(
          `Mail retention: deleted ${String(deleted)} old messages, cleared ${String(cleared)} addresses`,
        );
      }
    } catch (error) {
      this.logger.warn(`Mail retention sweep failed: ${message(error)}`);
    }
  }
}

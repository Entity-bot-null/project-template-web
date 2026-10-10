import { AsyncResource } from 'node:async_hooks';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ErrorReply, TimeoutError } from '@redis/client';
import { DeadlineExceededError, withDeadline } from '../../common/utils/deadline.js';
import { redactUrl } from '../../observability/redact.js';
import { REDIS_CLIENT_FACTORY, REDIS_OPTIONS } from './redis.constants.js';
import type {
  RedisClient,
  RedisClientFactory,
  RedisCommands,
  RedisOptions,
} from './redis.types.js';

/** Thrown when Redis is not configured, not connected, or too slow to answer. */
export class RedisUnavailableError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`Redis unavailable: ${reason}`, options);
    this.name = 'RedisUnavailableError';
  }
}

export type RedisStatus = 'disabled' | 'connecting' | 'ready' | 'unavailable' | 'closed';
export type RedisHealth = 'ok' | 'unavailable' | 'disabled';

// Server replies that mean "not now", not "wrong command": among them a Redis
// that cannot persist (MISCONF, a full disk) or is out of memory (OOM).
const TRANSIENT_REPLY = /^(LOADING|BUSY|MASTERDOWN|READONLY|TRYAGAIN|CLUSTERDOWN|MISCONF|OOM)\b/;

const CLOSE_TIMEOUT_MS = 2_000;
/** Commands in a row without a reply in time, before the service stops waiting on Redis. */
export const STALL_THRESHOLD = 3;
/** How long commands then fail at once, before a PING probes Redis again. */
export const STALL_COOL_OFF_MS = 5_000;

// The one Redis connection of the process (docs/architecture.md#redis). Only
// the infrastructure adapters use it (cache, rate limit store, locks): an ESLint
// rule keeps Redis calls out of feature code.
//
// It never stands between the API and its boot: the connection is opened in the
// background, and while Redis is down (or before it ever came up) every command
// fails at once with RedisUnavailableError, which each adapter turns into its
// documented degraded behavior. The client keeps reconnecting with backoff.
// Only state changes are logged (connected, lost, restored), never each retry,
// and never the URL's credentials.
//
// A Redis that stays connected but stops answering (paused, stuck in a
// script, behind a blackholed route) would make every request wait for
// REDIS_COMMAND_TIMEOUT_MS. After STALL_THRESHOLD commands in a row got no
// reply in time, commands fail at once, without being sent, for a cool-off
// (STALL_COOL_OFF_MS); then one PING probes Redis. A reply in time ends it;
// another timeout starts a new cool-off.
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: RedisClient | undefined;
  private state: RedisStatus;
  private unavailableSince: number | undefined;
  private missedReplies = 0;
  private stalledSince: number | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  // Bound where the service is built, at boot: a probe scheduled while serving
  // a request does not run (and log) as part of that request.
  private readonly probeOutsideRequests = AsyncResource.bind(() => {
    void this.probe();
  });

  constructor(
    @Inject(REDIS_OPTIONS) private readonly options: RedisOptions,
    @Inject(REDIS_CLIENT_FACTORY) private readonly createClient: RedisClientFactory,
  ) {
    this.state = options.url === undefined ? 'disabled' : 'connecting';
  }

  get status(): RedisStatus {
    return this.state;
  }

  /** Configured: features use Redis (or degrade while it is down). */
  get enabled(): boolean {
    return this.options.url !== undefined;
  }

  /** Readiness fails while Redis is down (REDIS_REQUIRED). */
  get required(): boolean {
    return this.options.required;
  }

  /** A key in this application's namespace: REDIS_KEY_PREFIX + parts joined by ":". */
  key(...parts: string[]): string {
    return `${this.options.keyPrefix}${parts.join(':')}`;
  }

  onModuleInit(): void {
    const { url } = this.options;
    if (url === undefined) return;
    this.warnAboutInsecureUrl(url);
    const client = this.createClient({ url, commandTimeoutMs: this.options.commandTimeoutMs });
    client.on('ready', () => {
      this.markReady();
    });
    // An 'error' listener is mandatory: without one the client's errors would
    // crash the process. Each failed reconnect emits one, and so does a
    // connection that is still up: a keep-alive PING answered BUSY or late, a
    // reply node-redis could not decode. Only a lost connection is an outage;
    // on a live one the commands report their own failures (and a stall).
    client.on('error', (error: unknown) => {
      if (client.isReady) {
        this.logger.debug(`Redis error on a live connection: ${describe(error)}`);
        return;
      }
      this.markUnavailable(error);
    });
    client.on('end', () => {
      if (this.state !== 'closed') this.markUnavailable(new Error('connection closed'));
    });
    this.client = client;
    // In the background: the boot does not wait for Redis.
    client.connect().catch((error: unknown) => {
      this.markUnavailable(error);
    });
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    this.state = 'closed';
    this.client = undefined;
    this.endStall();
    // close() lets queued replies arrive; destroy() is the fallback when it hangs.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, CLOSE_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([client.close().then(() => 'closed' as const), timeout]);
      if (outcome === 'timeout') destroyQuietly(client);
      this.logger.log('Redis connection closed');
    } catch {
      // close() failed (often after it already closed the socket, so destroy()
      // throws too): the shutdown goes on either way, so the telemetry and
      // error-tracker flush that follows still runs.
      destroyQuietly(client);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs commands on the connection. Throws RedisUnavailableError when Redis
   * is not configured, not connected, slow (REDIS_COMMAND_TIMEOUT_MS), stalled
   * (see the class comment) or temporarily refusing commands; any other error
   * (a wrong command, a script bug) is rethrown as is.
   */
  async run<T>(operation: (redis: RedisCommands) => Promise<T>): Promise<T> {
    const client = this.client;
    if (client === undefined) {
      throw new RedisUnavailableError(this.enabled ? 'connection closed' : 'not configured');
    }
    if (!client.isReady) throw new RedisUnavailableError('not connected');
    if (this.isStalled()) {
      throw new RedisUnavailableError('not answering (commands fail at once until it does)');
    }
    return this.send(client, operation);
  }

  /** For the readiness probe: a PING within the command timeout. */
  async health(): Promise<RedisHealth> {
    if (!this.enabled) return 'disabled';
    try {
      await this.run((redis) => redis.ping());
      return 'ok';
    } catch {
      return 'unavailable';
    }
  }

  private async send<T>(
    client: RedisClient,
    operation: (redis: RedisCommands) => Promise<T>,
  ): Promise<T> {
    // node-redis's own command timeout stops counting once a command is
    // written to the socket: a Redis that is connected but stopped answering
    // would hold the command, and the request waiting on it, forever. This
    // deadline covers the whole operation; a reply that arrives later is
    // dropped.
    const { commandTimeoutMs } = this.options;
    try {
      const result = await withDeadline(
        Promise.resolve().then(() => operation(client)),
        commandTimeoutMs,
      );
      this.answered();
      return result;
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        this.missedReply();
        throw new RedisUnavailableError(`no reply within ${String(commandTimeoutMs)} ms`);
      }
      // node-redis's own timeout: the command could not even be written.
      if (error instanceof TimeoutError) this.missedReply();
      if (error instanceof ErrorReply) {
        // An error reply is still a reply: Redis answers.
        this.answered();
        if (!TRANSIENT_REPLY.test(error.message)) throw error;
      }
      if (error instanceof RedisUnavailableError) throw error;
      throw new RedisUnavailableError(describe(error), { cause: error });
    }
  }

  /** Commands fail at once: Redis is connected but stopped answering. */
  private isStalled(): boolean {
    return this.stalledSince !== undefined;
  }

  private missedReply(): void {
    this.missedReplies += 1;
    if (this.missedReplies < STALL_THRESHOLD || this.isStalled()) return;
    this.stalledSince = Date.now();
    this.logger.warn(
      `Redis is not answering (${this.host()}): ${String(STALL_THRESHOLD)} commands in a row got no reply within ${String(this.options.commandTimeoutMs)} ms. Commands fail at once, and features use their degraded mode, until a probe gets a reply (docs/architecture.md#degradation).`,
    );
    this.scheduleProbe();
  }

  private answered(): void {
    this.missedReplies = 0;
    if (this.stalledSince === undefined) return;
    const seconds = Math.round((Date.now() - this.stalledSince) / 1000);
    this.endStall();
    this.logger.log(`Redis answering again after ${String(seconds)}s`);
  }

  private endStall(): void {
    this.stalledSince = undefined;
    this.missedReplies = 0;
    clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
  }

  private scheduleProbe(): void {
    clearTimeout(this.probeTimer);
    // unref: a pending probe never keeps the process alive.
    this.probeTimer = setTimeout(
      this.probeOutsideRequests,
      this.options.stallCoolOffMs ?? STALL_COOL_OFF_MS,
    ).unref();
  }

  /** After a cool-off, one PING: a reply ends the stall (send()), anything else starts another. */
  private async probe(): Promise<void> {
    const client = this.client;
    if (client === undefined || !this.isStalled()) return;
    try {
      await this.send(client, (redis) => redis.ping());
    } catch {
      // Unless a reply, a reconnect or the shutdown ended the stall meanwhile.
      if (this.isStalled()) this.scheduleProbe();
    }
  }

  private markReady(): void {
    const previous = this.state;
    this.state = 'ready';
    // A new connection: whatever stalled the previous one went with it.
    this.endStall();
    if (previous === 'unavailable' && this.unavailableSince !== undefined) {
      const seconds = Math.round((Date.now() - this.unavailableSince) / 1000);
      this.logger.log(`Redis connection restored after ${seconds}s`);
    } else {
      this.logger.log(`Redis connected (${this.host()})`);
    }
    this.unavailableSince = undefined;
  }

  private markUnavailable(error: unknown): void {
    if (this.state === 'closed' || this.state === 'unavailable') return;
    this.state = 'unavailable';
    this.unavailableSince = Date.now();
    this.logger.warn(
      `Redis unavailable (${this.host()}): ${describe(error)}. Features fall back to their degraded mode while the client reconnects (docs/architecture.md#degradation).`,
    );
  }

  private host(): string {
    return this.options.url === undefined ? 'not configured' : redactUrl(this.options.url);
  }

  private warnAboutInsecureUrl(url: string): void {
    if (!this.options.production) return;
    const parsed = new URL(url);
    if (parsed.protocol === 'redis:') {
      this.logger.warn(
        'REDIS_URL is not encrypted (redis://): use rediss:// unless Redis is only reachable on a private network (docs/security.md#redis).',
      );
    }
    if (parsed.password === '') {
      this.logger.warn(
        'REDIS_URL has no password: every client that reaches Redis can read and write it.',
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** destroy() throws on a client that is already closed: nothing left to release then. */
function destroyQuietly(client: RedisClient): void {
  try {
    client.destroy();
  } catch {
    // Already closed.
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';
import { LEASE_STORE, type LeaseStore } from './lease.store.js';

// Coordination between instances (docs/architecture.md#locks-and-idempotency).
// Prepared, not used by the template itself: reach for these when two
// instances must not do the same thing at the same time, or when the same
// message may arrive twice.
//
// With REDIS_URL they hold across every instance; without it, within one
// process only. While Redis is down they fail closed (RedisUnavailableError):
// skipping a job or answering 503 is recoverable, running it twice may not be.
//
// These are efficiency and deduplication tools, not correctness guarantees: a
// lease can expire while its owner is paused (GC, a slow query) and someone
// else then acquires it. Where a duplicate would be a real error (charging a
// card twice), make the write itself idempotent: a unique constraint on the
// idempotency key in the same database transaction as the effect.

const NAME = /^[a-z][a-z0-9:_-]{0,127}$/;

export type LockOutcome<T> = { acquired: true; result: T } | { acquired: false };

@Injectable()
export class LockService {
  constructor(
    @Inject(LEASE_STORE) private readonly store: LeaseStore,
    private readonly redis: RedisService,
  ) {}

  /**
   * Runs `work` only if no other holder has `name`; otherwise returns
   * { acquired: false } at once (no waiting). `ttlMs` must exceed the work's
   * longest run: the lock expires after it whether or not the work finished.
   *
   *   const run = await locks.withLock('jobs:nightly-report', 10 * 60_000, () => this.report());
   *   if (!run.acquired) this.logger.log('Another instance is running the report');
   */
  async withLock<T>(name: string, ttlMs: number, work: () => Promise<T>): Promise<LockOutcome<T>> {
    const key = this.redis.key('lock', checkedName(name));
    const token = await this.store.acquire(key, ttlMs);
    if (token === null) return { acquired: false };
    try {
      return { acquired: true, result: await work() };
    } finally {
      // A release that fails (Redis went away meanwhile) is harmless: the
      // lease expires with its TTL. It must not hide the work's own outcome.
      await this.store.release(key, token).catch(() => false);
    }
  }
}

export interface Claim {
  /**
   * Records the message as processed: later deliveries are 'done' for
   * `doneTtlSec`. Call it once the effect succeeded. It never rejects: the
   * effect happened and the sender must get its 2xx. When the store cannot
   * record it (Redis went away), the processing lease runs out and a
   * redelivery after that is processed again.
   */
  complete(): Promise<void>;
  /** Gives the key back, so a retry of the same message is processed. Call it when processing failed. */
  release(): Promise<void>;
}

export type ClaimOutcome =
  /** This caller processes the message. */
  | { status: 'claimed'; claim: Claim }
  /** Another delivery of it is being processed now: answer non-2xx, so the sender retries later. */
  | { status: 'in-progress' }
  /** Processed already: acknowledge it (2xx) and do nothing. */
  | { status: 'done' };

export interface ClaimOptions {
  /**
   * Longer than processing can take. Past it, an attempt that crashed or hangs
   * no longer holds the message, and the sender's next retry processes it.
   */
  processingTtlSec: number;
  /** How long a processed message is remembered: the sender's redelivery window. */
  doneTtlSec: number;
}

// What a processed message's key holds; owner tokens are random UUIDs.
const DONE = 'done';

@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(LEASE_STORE) private readonly store: LeaseStore,
    private readonly redis: RedisService,
  ) {}

  /**
   * Claims a message id (a webhook delivery id, a job id). "In progress" and
   * "done" are told apart: a delivery that arrives while the first one is
   * still being processed must not be acknowledged, or the message is lost
   * when that first attempt fails or crashes (the sender stops retrying
   * after a 2xx).
   *
   *   const outcome = await idempotency.claim('webhooks:billing', event.id, {
   *     processingTtlSec: 5 * 60,
   *     doneTtlSec: 24 * 3600,
   *   });
   *   if (outcome.status === 'done') return; // a duplicate: acknowledge it
   *   if (outcome.status === 'in-progress') throw new ConflictException('Being processed, retry later');
   *   try { await this.apply(event); } catch (error) { await outcome.claim.release(); throw error; }
   *   await outcome.claim.complete();
   */
  async claim(scope: string, key: string, options: ClaimOptions): Promise<ClaimOutcome> {
    const processingMs = wholeSeconds(options.processingTtlSec) * 1000;
    const doneMs = wholeSeconds(options.doneTtlSec) * 1000;
    const leaseKey = this.redis.key('idempotency', checkedName(scope), key);
    const token = await this.store.acquire(leaseKey, processingMs);
    if (token === null) {
      // Gone between the two calls (released, expired) reads as in progress:
      // the sender retries, and the retry gets the claim.
      return (await this.store.read(leaseKey)) === DONE
        ? { status: 'done' }
        : { status: 'in-progress' };
    }
    return {
      status: 'claimed',
      claim: {
        complete: async () => {
          await this.store.write(leaseKey, DONE, doneMs).catch(() => undefined);
        },
        release: async () => {
          // Only this attempt's own lease: never a completed key, nor one a
          // retry took over after the processing TTL.
          await this.store.release(leaseKey, token);
        },
      },
    };
  }
}

function wholeSeconds(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`Idempotency TTLs are whole seconds above 0, not ${String(seconds)}`);
  }
  return seconds;
}

function checkedName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Lock or scope name "${name}" must match ${String(NAME)}`);
  return name;
}

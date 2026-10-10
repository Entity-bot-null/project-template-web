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
  /** Gives the key back, so a retry of the same message is processed. Call it when processing failed. */
  release(): Promise<void>;
}

@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(LEASE_STORE) private readonly store: LeaseStore,
    private readonly redis: RedisService,
  ) {}

  /**
   * Claims a message id (a webhook delivery id, a job id) for `ttlSec`: the
   * first caller gets a Claim, every later one null (a duplicate to skip).
   * Keep the claim on success, so duplicates within the TTL are dropped;
   * release it on failure, so the sender's retry is processed.
   *
   *   const claim = await idempotency.claim('webhooks:billing', event.id, 24 * 3600);
   *   if (claim === null) return; // already processed or in progress
   *   try { await this.apply(event); } catch (error) { await claim.release(); throw error; }
   */
  async claim(scope: string, key: string, ttlSec: number): Promise<Claim | null> {
    const leaseKey = this.redis.key('idempotency', checkedName(scope), key);
    const token = await this.store.acquire(leaseKey, ttlSec * 1000);
    if (token === null) return null;
    return {
      release: async () => {
        await this.store.release(leaseKey, token);
      },
    };
  }
}

function checkedName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Lock or scope name "${name}" must match ${String(NAME)}`);
  return name;
}

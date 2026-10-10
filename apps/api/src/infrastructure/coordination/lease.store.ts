import { randomUUID } from 'node:crypto';
import { RedisService, RedisUnavailableError } from '../redis/redis.service.js';

// A lease: a key held by one owner until it is released or its TTL runs out.
// The primitive behind distributed locks and idempotency claims
// (coordination.service.ts). The TTL is what makes a crashed owner harmless:
// its lease simply expires.
export interface LeaseStore {
  /** The owner token, or null when someone else holds the key. */
  acquire(key: string, ttlMs: number): Promise<string | null>;
  /** True when the token still owned the key (and now released it). */
  release(key: string, token: string): Promise<boolean>;
  /** What the key holds now (an owner token, or a value written), or null. */
  read(key: string): Promise<string | null>;
  /** Makes the key hold `value` for `ttlMs`, whoever owned it: no token releases it then. */
  write(key: string, value: string, ttlMs: number): Promise<void>;
}

export const LEASE_STORE = Symbol('LEASE_STORE');

/** One instance: correct in a single process only (documented: docs/architecture.md#locks-and-idempotency). */
export class MemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, { value: string; expiresAt: number }>();
  private acquiresSinceSweep = 0;
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  acquire(key: string, ttlMs: number): Promise<string | null> {
    this.sweepNowAndThen();
    if (this.live(key) !== undefined) return Promise.resolve(null);
    const token = randomUUID();
    this.leases.set(key, { value: token, expiresAt: this.now() + ttlMs });
    return Promise.resolve(token);
  }

  // Claims kept on purpose (a processed idempotency key) are never released:
  // without a sweep they would stay in memory for the life of the process,
  // one per message id. Every 100 acquisitions, or a minute after the last
  // sweep, expired leases are dropped: memory follows the leases still alive.
  private sweepNowAndThen(): void {
    this.acquiresSinceSweep += 1;
    const now = this.now();
    if (this.acquiresSinceSweep < 100 && now - this.lastSweep < 60_000) return;
    this.acquiresSinceSweep = 0;
    this.lastSweep = now;
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(key);
    }
  }

  release(key: string, token: string): Promise<boolean> {
    if (this.live(key) !== token) return Promise.resolve(false);
    this.leases.delete(key);
    return Promise.resolve(true);
  }

  read(key: string): Promise<string | null> {
    return Promise.resolve(this.live(key) ?? null);
  }

  write(key: string, value: string, ttlMs: number): Promise<void> {
    this.leases.set(key, { value, expiresAt: this.now() + ttlMs });
    return Promise.resolve();
  }

  private live(key: string): string | undefined {
    const current = this.leases.get(key);
    return current !== undefined && current.expiresAt > this.now() ? current.value : undefined;
  }
}

// Releases only the caller's own lease: a lease that expired and was taken by
// someone else must not be deleted by its previous owner.
export const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Every instance sharing the Redis. Fails closed: RedisUnavailableError, never "acquired". */
export class RedisLeaseStore implements LeaseStore {
  constructor(private readonly redis: RedisService) {}

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    try {
      const reply = await this.redis.run((redis) =>
        redis.set(key, token, { expiration: { type: 'PX', value: ttlMs }, condition: 'NX' }),
      );
      return reply === 'OK' ? token : null;
    } catch (error) {
      // No answer in time does not mean nothing happened: Redis may have
      // applied the SET and answered after REDIS_COMMAND_TIMEOUT_MS. Releasing
      // this call's own token (the script deletes only its own value) keeps a
      // failed claim from refusing the caller's retry for the whole TTL. When
      // Redis is down for good this fails too, and the lease expires by itself.
      if (error instanceof RedisUnavailableError) {
        await this.release(key, token).catch(() => false);
      }
      throw error;
    }
  }

  async release(key: string, token: string): Promise<boolean> {
    const reply = await this.redis.run((redis) =>
      redis.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] }),
    );
    return reply === 1;
  }

  async read(key: string): Promise<string | null> {
    return this.redis.run((redis) => redis.get(key));
  }

  async write(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.run((redis) =>
      redis.set(key, value, { expiration: { type: 'PX', value: ttlMs } }),
    );
  }
}

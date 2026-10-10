import { RedisService } from '../redis/redis.service.js';

// Where cache entries live (CACHE_STORE). Values are strings: CacheService
// serializes. Every entry has a TTL; there is no "forever".
export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Adds one to a counter and returns the new value (namespace generations). */
  increment(key: string): Promise<number>;
}

/** Provider token of the active store. */
export const CACHE_STORE = Symbol('CACHE_STORE');

const DEFAULT_MAX_ENTRIES = 10_000;

// One instance: entries live in the process, bounded in number (the oldest
// are evicted first). Several instances each keep their own copy, so an
// invalidation reaches only the instance that ran it: use the Redis store
// there, or keep TTLs short.
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): Promise<string | undefined> {
    // Counters read back as strings, like Redis INCR keys.
    const counter = this.counters.get(key);
    if (counter !== undefined) return Promise.resolve(String(counter));
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.resolve(undefined);
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: string, ttlSec: number): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlSec * 1000 });
    // Maps iterate in insertion order: the first key is the oldest write.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  increment(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return Promise.resolve(next);
  }
}

// Shared by every instance. Errors surface as RedisUnavailableError, which
// CacheService turns into cache misses.
export class RedisCacheStore implements CacheStore {
  constructor(private readonly redis: RedisService) {}

  async get(key: string): Promise<string | undefined> {
    const value = await this.redis.run((redis) => redis.get(key));
    return value ?? undefined;
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    await this.redis.run((redis) =>
      redis.set(key, value, { expiration: { type: 'EX', value: ttlSec } }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.redis.run((redis) => redis.del(key));
  }

  increment(key: string): Promise<number> {
    return this.redis.run((redis) => redis.incr(key));
  }
}

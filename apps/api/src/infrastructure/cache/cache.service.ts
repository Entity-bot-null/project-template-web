import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { recordCacheRead, recordDegradation } from '../../observability/metrics.js';
import { RedisService, RedisUnavailableError } from '../redis/redis.service.js';
import { CACHE_STORE, type CacheStore } from './cache.store.js';

// Caching (docs/architecture.md#cache), explicit and opt-in: nothing is cached
// unless a service asks for it, and HTTP responses never are. Read the "When
// not to cache" list before adding a namespace: authorization decisions,
// sessions, tokens and anything a user must see change at once stay out.
//
//   const users = cache.namespace<UserView>('user-profile', { ttlSec: 60 });
//   const view = await users.getOrSet(id, () => this.loadProfile(id));
//   ...after a change: await users.delete(id), or users.invalidate() for all.
//
// Keys: REDIS_KEY_PREFIX + "cache:" + namespace + ":" + generation + ":" + key.
// invalidate() bumps the namespace's generation, so every older entry becomes
// unreachable at once (and expires with its TTL) without scanning keys.
//
// Degradation: a store that fails (Redis down) makes reads misses and writes
// no-ops, so the source of truth serves every request. A failed delete or
// invalidate is retried before the next successful operation; the TTL bounds
// how long an entry can outlive a change in the worst case.

/** No entry outlives this, whatever its namespace asks. */
export const MAX_TTL_SEC = 24 * 60 * 60;
const MAX_KEY_LENGTH = 200;
// Past this many keys whose delete failed, one invalidate() is cheaper than
// replaying them, and keeps the queue's memory bounded during an outage.
const MAX_PENDING_DELETES = 100;
const NAMESPACE = /^[a-z][a-z0-9-]{0,31}$/;

export interface NamespaceOptions {
  /** Default lifetime of the namespace's entries, in seconds (1 to MAX_TTL_SEC). */
  ttlSec: number;
}

@Injectable()
export class CacheService {
  private readonly namespaces = new Map<string, NamespacedCache<unknown>>();

  constructor(
    @Inject(CACHE_STORE) private readonly store: CacheStore,
    private readonly redis: RedisService,
  ) {}

  /** The cache of one kind of value. Each name is declared once, with one TTL. */
  namespace<T>(name: string, options: NamespaceOptions): NamespacedCache<T> {
    if (!NAMESPACE.test(name)) {
      throw new Error(`Cache namespace "${name}" must match ${String(NAMESPACE)}`);
    }
    const existing = this.namespaces.get(name);
    if (existing !== undefined) return existing as NamespacedCache<T>;
    const created = new NamespacedCache<T>(
      this.store,
      (...parts) => this.redis.key('cache', name, ...parts),
      name,
      checkedTtl(options.ttlSec),
    );
    this.namespaces.set(name, created);
    return created;
  }
}

export class NamespacedCache<T> {
  private readonly logger: Logger;
  // Loads in progress, shared by concurrent readers of a key. A set() or a
  // delete() of the key, or an invalidate(), marks them stale: a reader that
  // comes after the change does not join them, and a stale load's result is
  // not cached (it would overwrite the change).
  private readonly inFlight = new Map<string, { promise: Promise<T>; stale: boolean }>();
  // Deletes and invalidations that failed, replayed before the next
  // operation. Bounded: a key is pending once however often it was deleted,
  // and past MAX_PENDING_DELETES keys (or after a failed invalidate) one
  // invalidate() replaces them all. One replay at a time, shared by callers.
  private readonly pendingDeletes = new Set<string>();
  private pendingInvalidate = false;
  private replaying: Promise<void> | undefined;
  private failing = false;

  constructor(
    private readonly store: CacheStore,
    private readonly key: (...parts: string[]) => string,
    private readonly name: string,
    private readonly ttlSec: number,
  ) {
    this.logger = new Logger(`Cache:${name}`);
  }

  async get(key: string): Promise<T | undefined> {
    return (await this.read(key)).value;
  }

  /** `undefined` is never stored: it means "not cached". */
  async set(key: string, value: T, ttlSec: number = this.ttlSec): Promise<void> {
    this.forgetLoad(key);
    await this.write(undefined, key, value, ttlSec);
  }

  async delete(key: string): Promise<void> {
    this.forgetLoad(key);
    try {
      await this.replayPending();
      await this.store.delete(this.entryKey(await this.generation(), key));
      this.recovered();
    } catch (error) {
      // A pending invalidation already covers the key. Past the bound, one
      // replaces every pending key, so the queue's memory stays bounded.
      if (!this.pendingInvalidate) this.pendingDeletes.add(key);
      if (this.pendingDeletes.size > MAX_PENDING_DELETES) {
        this.pendingInvalidate = true;
        this.pendingDeletes.clear();
      }
      this.notApplied(error);
    }
  }

  /** Drops every entry of the namespace, on every instance sharing the store. */
  async invalidate(): Promise<void> {
    for (const key of [...this.inFlight.keys()]) this.forgetLoad(key);
    try {
      await this.replayPending();
      await this.store.increment(this.key('generation'));
      this.recovered();
    } catch (error) {
      // The invalidation covers every pending delete.
      this.pendingInvalidate = true;
      this.pendingDeletes.clear();
      this.notApplied(error);
    }
  }

  /**
   * The cached value, or the loader's result (then cached). Concurrent calls
   * for the same key in this instance share one load (no stampede on a cold
   * key). A loader error is not cached and reaches the caller.
   */
  async getOrSet(key: string, load: () => Promise<T>, ttlSec: number = this.ttlSec): Promise<T> {
    // The generation is read before loading: if invalidate() runs while the
    // load is in progress, the (possibly stale) result is written under the
    // old generation, where no reader looks.
    const { value: cached, generation } = await this.read(key);
    if (cached !== undefined) return cached;
    const running = this.inFlight.get(key);
    if (running !== undefined) return running.promise;
    const flight = { promise: Promise.resolve() as Promise<T>, stale: false };
    flight.promise = (async () => {
      try {
        // Called inside the chain: a loader that throws synchronously rejects
        // this load like any other failure, after it was registered, so the
        // cleanup below always finds it.
        const value = await Promise.resolve().then(load);
        // A failed read gave no generation: whether an invalidate() raced the
        // load is unknown, so the result is not cached; nor is a load that a
        // delete() or invalidate() made stale.
        if (generation !== undefined && !flight.stale) {
          await this.write(generation, key, value, ttlSec);
        }
        return value;
      } finally {
        if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, flight);
    return flight.promise;
  }

  private forgetLoad(key: string): void {
    const flight = this.inFlight.get(key);
    if (flight === undefined) return;
    flight.stale = true;
    this.inFlight.delete(key);
  }

  private async read(key: string): Promise<{ value: T | undefined; generation?: string }> {
    let generation: string;
    let raw: string | undefined;
    try {
      await this.replayPending();
      generation = await this.generation();
      raw = await this.store.get(this.entryKey(generation, key));
      this.recovered();
    } catch (error) {
      recordCacheRead(this.name, 'error');
      this.degraded(error);
      return { value: undefined };
    }
    // Parsed outside the outage path: the store answered. An entry that is not
    // valid JSON (cut off, or written by something else) is a miss, and the
    // generation is known, so getOrSet() overwrites it with a fresh value.
    const value = raw === undefined ? undefined : this.parse(raw);
    recordCacheRead(this.name, value === undefined ? 'miss' : 'hit');
    return { value, generation };
  }

  private parse(raw: string): T | undefined {
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Neither the key nor the value, nor the parser's message (V8 quotes
      // part of the input): any of them can carry personal data.
      this.logger.warn(
        'A cache entry could not be read (not valid JSON): treated as a miss, replaced by the next load',
      );
      return undefined;
    }
  }

  private async write(
    generation: string | undefined,
    key: string,
    value: T,
    ttlSec: number,
  ): Promise<void> {
    if (value === undefined) return;
    try {
      await this.replayPending();
      const at = generation ?? (await this.generation());
      await this.store.set(this.entryKey(at, key), JSON.stringify(value), checkedTtl(ttlSec));
      this.recovered();
    } catch (error) {
      this.degraded(error);
    }
  }

  private async generation(): Promise<string> {
    return (await this.store.get(this.key('generation'))) ?? '0';
  }

  private entryKey(generation: string, key: string): string {
    // Long keys (a search string, say) are hashed: bounded size, same identity.
    const safeKey =
      key.length > MAX_KEY_LENGTH
        ? `sha256-${createHash('sha256').update(key).digest('hex')}`
        : key;
    return this.key(generation, safeKey);
  }

  private notApplied(error: unknown): void {
    this.logger.error(
      `Cache change not applied, will retry before the next cache operation: ${describe(error)}`,
    );
    this.degraded(error);
  }

  private replayPending(): Promise<void> {
    if (!this.pendingInvalidate && this.pendingDeletes.size === 0) return Promise.resolve();
    this.replaying ??= this.replay().finally(() => {
      this.replaying = undefined;
    });
    return this.replaying;
  }

  private async replay(): Promise<void> {
    if (this.pendingInvalidate) {
      await this.store.increment(this.key('generation'));
      this.pendingInvalidate = false;
      this.pendingDeletes.clear();
      return;
    }
    const generation = await this.generation();
    for (const key of [...this.pendingDeletes]) {
      await this.store.delete(this.entryKey(generation, key));
      this.pendingDeletes.delete(key);
    }
  }

  private degraded(error: unknown): void {
    recordDegradation('cache', error instanceof RedisUnavailableError ? 'redis' : 'store');
    if (this.failing) return;
    this.failing = true;
    this.logger.warn(`Cache unavailable, serving from the source: ${describe(error)}`);
  }

  private recovered(): void {
    if (!this.failing) return;
    this.failing = false;
    this.logger.log('Cache available again');
  }
}

function checkedTtl(ttlSec: number): number {
  if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_TTL_SEC) {
    throw new Error(`Cache TTL must be a whole number of seconds from 1 to ${MAX_TTL_SEC}`);
  }
  return ttlSec;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

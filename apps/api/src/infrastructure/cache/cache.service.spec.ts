import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisService, RedisUnavailableError } from '../redis/redis.service.js';
import { CacheService, MAX_TTL_SEC } from './cache.service.js';
import { type CacheStore, MemoryCacheStore } from './cache.store.js';

const redisKeys = {
  key: (...parts: string[]) => `app:${parts.join(':')}`,
} as unknown as RedisService;

function cacheOver(store: CacheStore) {
  return new CacheService(store, redisKeys);
}

/** A store that fails (Redis down) until `up` is set. */
class FlakyStore implements CacheStore {
  up = false;
  readonly inner = new MemoryCacheStore();
  private check() {
    if (!this.up) throw new RedisUnavailableError('not connected');
  }
  get(key: string) {
    this.check();
    return this.inner.get(key);
  }
  set(key: string, value: string, ttlSec: number) {
    this.check();
    return this.inner.set(key, value, ttlSec);
  }
  delete(key: string) {
    this.check();
    return this.inner.delete(key);
  }
  increment(key: string) {
    this.check();
    return this.inner.increment(key);
  }
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('MemoryCacheStore', () => {
  it('expires entries after their TTL', async () => {
    let now = 1_000_000;
    const store = new MemoryCacheStore(10, () => now);
    await store.set('k', 'v', 60);
    now += 59_999;
    await expect(store.get('k')).resolves.toBe('v');
    now += 1;
    await expect(store.get('k')).resolves.toBeUndefined();
  });

  it('stays bounded, evicting the oldest writes', async () => {
    const store = new MemoryCacheStore(2);
    await store.set('a', '1', 60);
    await store.set('b', '2', 60);
    await store.set('c', '3', 60);
    await expect(store.get('a')).resolves.toBeUndefined();
    await expect(store.get('c')).resolves.toBe('3');
  });
});

describe('CacheService', () => {
  it('stores JSON values per namespace, with the namespace TTL', async () => {
    const store = new MemoryCacheStore();
    const set = vi.spyOn(store, 'set');
    const profiles = cacheOver(store).namespace<{ name: string }>('profiles', { ttlSec: 30 });
    await profiles.set('u1', { name: 'Ada' });
    await expect(profiles.get('u1')).resolves.toEqual({ name: 'Ada' });
    expect(set).toHaveBeenCalledWith('app:cache:profiles:0:u1', '{"name":"Ada"}', 30);
    await expect(
      cacheOver(store).namespace('other', { ttlSec: 30 }).get('u1'),
    ).resolves.toBeUndefined();
  });

  it('deletes one entry, or invalidates the whole namespace at once', async () => {
    const store = new MemoryCacheStore();
    const cache = cacheOver(store).namespace<number>('counts', { ttlSec: 60 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.delete('a');
    await expect(cache.get('a')).resolves.toBeUndefined();
    await expect(cache.get('b')).resolves.toBe(2);
    await cache.invalidate();
    await expect(cache.get('b')).resolves.toBeUndefined();
    // A second instance sharing the store sees the invalidation too.
    await expect(
      cacheOver(store).namespace('counts', { ttlSec: 60 }).get('b'),
    ).resolves.toBeUndefined();
  });

  it('loads a missing value once for concurrent callers, and caches it', async () => {
    const cache = cacheOver(new MemoryCacheStore()).namespace<string>('reports', { ttlSec: 60 });
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('built');
          }, 10);
        }),
    );
    const results = await Promise.all([1, 2, 3].map(() => cache.getOrSet('r1', load)));
    expect(results).toEqual(['built', 'built', 'built']);
    expect(load).toHaveBeenCalledOnce();
    await expect(cache.getOrSet('r1', load)).resolves.toBe('built');
    expect(load).toHaveBeenCalledOnce();
  });

  it('never lets a load that raced an invalidation serve its stale result', async () => {
    const cache = cacheOver(new MemoryCacheStore()).namespace<string>('prices', { ttlSec: 60 });
    let finishLoad!: (value: string) => void;
    const slowLoad = cache.getOrSet(
      'p1',
      () =>
        new Promise<string>((resolve) => {
          finishLoad = resolve;
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    await cache.invalidate(); // the price changed while the old one was being read
    finishLoad('old price');
    await expect(slowLoad).resolves.toBe('old price');
    await expect(cache.get('p1')).resolves.toBeUndefined();
  });

  it('never caches a failed load or undefined', async () => {
    const cache = cacheOver(new MemoryCacheStore()).namespace<string | undefined>('x', {
      ttlSec: 60,
    });
    await expect(cache.getOrSet('k', () => Promise.reject(new Error('db down')))).rejects.toThrow(
      'db down',
    );
    await cache.set('k', undefined);
    const load = vi.fn(() => Promise.resolve('fresh'));
    await expect(cache.getOrSet('k', load)).resolves.toBe('fresh');
    expect(load).toHaveBeenCalledOnce();
  });

  it('serves from the source while the store is down: reads miss, writes are skipped', async () => {
    const store = new FlakyStore();
    const cache = cacheOver(store).namespace<string>('users', { ttlSec: 60 });
    await expect(cache.get('u1')).resolves.toBeUndefined();
    await expect(cache.set('u1', 'v')).resolves.toBeUndefined();
    await expect(cache.getOrSet('u1', () => Promise.resolve('from db'))).resolves.toBe('from db');
  });

  it('retries an invalidation that failed before the next operation, so nothing stays stale', async () => {
    const store = new FlakyStore();
    store.up = true;
    const cache = cacheOver(store).namespace<string>('users', { ttlSec: 60 });
    await cache.set('u1', 'old');
    store.up = false;
    await cache.invalidate();
    store.up = true;
    await expect(cache.get('u1')).resolves.toBeUndefined();
  });

  it('treats a corrupted entry as a miss, not an outage, and replaces it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const store = new MemoryCacheStore();
    const profiles = cacheOver(store).namespace<{ name: string }>('profiles', { ttlSec: 60 });
    // Cut off mid-write, or written by something that is not this cache.
    await store.set('app:cache:profiles:0:u1', '{"name":"Ad', 60);

    await expect(profiles.get('u1')).resolves.toBeUndefined();
    const load = vi.fn(() => Promise.resolve({ name: 'Ada' }));
    await expect(profiles.getOrSet('u1', load)).resolves.toEqual({ name: 'Ada' });
    await expect(store.get('app:cache:profiles:0:u1')).resolves.toBe('{"name":"Ada"}');
    await expect(profiles.getOrSet('u1', load)).resolves.toEqual({ name: 'Ada' });
    expect(load).toHaveBeenCalledOnce();
    // The store answered: nothing was degraded.
    const warnings = warn.mock.calls.map(([message]) => String(message));
    expect(warnings.some((message) => message.startsWith('Cache unavailable'))).toBe(false);
    expect(warnings.some((message) => message.includes('could not be read'))).toBe(true);
  });

  it('refuses unbounded TTLs and malformed namespaces', () => {
    const service = cacheOver(new MemoryCacheStore());
    expect(() => service.namespace('ok', { ttlSec: 0 })).toThrow('Cache TTL');
    expect(() => service.namespace('ok', { ttlSec: MAX_TTL_SEC + 1 })).toThrow('Cache TTL');
    expect(() => service.namespace('Bad Name', { ttlSec: 10 })).toThrow('must match');
  });

  it('hashes very long keys', async () => {
    const store = new MemoryCacheStore();
    const set = vi.spyOn(store, 'set');
    await cacheOver(store).namespace<number>('search', { ttlSec: 60 }).set('q'.repeat(500), 1);
    expect(set.mock.calls[0]?.[0]).toMatch(/^app:cache:search:0:sha256-[0-9a-f]{64}$/);
  });
});

/** Fails every call (Redis down) until `up`; counts the calls once it is up. */
class OutageStore implements CacheStore {
  up = false;
  calls = 0;
  private readonly inner = new MemoryCacheStore(100_000);
  private reach() {
    if (!this.up) throw new RedisUnavailableError('not connected');
    this.calls += 1;
  }
  get(key: string) {
    this.reach();
    return this.inner.get(key);
  }
  set(key: string, value: string, ttlSec: number) {
    this.reach();
    return this.inner.set(key, value, ttlSec);
  }
  delete(key: string) {
    this.reach();
    return this.inner.delete(key);
  }
  increment(key: string) {
    this.reach();
    return this.inner.increment(key);
  }
}

describe('changes that failed during an outage', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  it('are replayed once per key, not once per call, when the store is back', async () => {
    const store = new OutageStore();
    const profiles = cacheOver(store).namespace<string>('profiles', { ttlSec: 60 });
    for (let i = 0; i < 5_000; i += 1) await profiles.delete(`user-${String(i % 50)}`);
    store.up = true;
    store.calls = 0;
    await profiles.get('user-1');
    expect(store.calls).toBeLessThan(60);
  });

  it('collapse into one invalidate() past the bound, which still drops the stale entries', async () => {
    const store = new OutageStore();
    store.up = true;
    const profiles = cacheOver(store).namespace<string>('profiles', { ttlSec: 60 });
    await profiles.set('user-7', 'stale');
    store.up = false;
    for (let i = 0; i < 1_000; i += 1) await profiles.delete(`user-${String(i)}`);
    store.up = true;
    store.calls = 0;
    await expect(profiles.get('user-7')).resolves.toBeUndefined();
    expect(store.calls).toBeLessThan(10);
  });

  it('stay bounded in memory, however many keys failed', async () => {
    const store = new OutageStore();
    const profiles = cacheOver(store).namespace<string>('profiles', { ttlSec: 60 });
    for (let i = 0; i < 10_000; i += 1) await profiles.delete(`user-${String(i)}`);
    const queued = (profiles as unknown as { pendingDeletes: Set<string> }).pendingDeletes;
    expect(queued.size).toBeLessThanOrEqual(100);
  });

  it('are replayed once for concurrent callers', async () => {
    const store = new OutageStore();
    const profiles = cacheOver(store).namespace<string>('profiles', { ttlSec: 60 });
    for (let i = 0; i < 20; i += 1) await profiles.delete(`user-${String(i)}`);
    store.up = true;
    store.calls = 0;
    await Promise.all(Array.from({ length: 10 }, (_, i) => profiles.get(`user-${String(i)}`)));
    // 1 generation read + 20 deletes for the replay, then 2 calls per read.
    expect(store.calls).toBe(21 + 10 * 2);
  });

  it('never cache a load whose first read failed: an invalidate() may have raced it', async () => {
    const store = new OutageStore();
    const profiles = cacheOver(store).namespace<string>('profiles', { ttlSec: 60 });
    let release!: (value: string) => void;
    const loading = profiles.getOrSet(
      'p',
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    store.up = true;
    await profiles.invalidate();
    release('old');
    await expect(loading).resolves.toBe('old');
    await expect(profiles.get('p')).resolves.toBeUndefined();
  });
});

describe('getOrSet and changes made while a load runs', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('does not keep the failure of a loader that throws synchronously', async () => {
    const profiles = cacheOver(new MemoryCacheStore()).namespace<string>('profiles', {
      ttlSec: 60,
    });
    const throwing = (): Promise<string> => {
      throw new Error('sync failure');
    };
    await expect(profiles.getOrSet('p1', throwing)).rejects.toThrow('sync failure');
    await expect(profiles.getOrSet('p1', () => Promise.resolve('fresh'))).resolves.toBe('fresh');
  });

  it.each([
    ['invalidate()', (cache: { invalidate(): Promise<void> }) => cache.invalidate()],
    ['delete()', (cache: { delete(key: string): Promise<void> }) => cache.delete('p1')],
    [
      'set()',
      (cache: { set(key: string, value: string): Promise<void> }) => cache.set('p1', 'new value'),
    ],
  ])(
    'gives a reader that starts after %s the new value, and caches no stale one',
    async (_label, change) => {
      const profiles = cacheOver(new MemoryCacheStore()).namespace<string>('profiles', {
        ttlSec: 60,
      });
      let finishOldLoad!: (value: string) => void;
      const oldLoad = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finishOldLoad = resolve;
          }),
      );
      const first = profiles.getOrSet('p1', oldLoad);
      await vi.waitFor(() => {
        expect(oldLoad).toHaveBeenCalled();
      });
      await change(profiles);
      const second = profiles.getOrSet('p1', () => Promise.resolve('new value'));
      // Let the second reader finish its read (and, with the bug, join the
      // old load) before that load completes.
      await new Promise((resolve) => setTimeout(resolve, 10));
      finishOldLoad('old value');
      await expect(first).resolves.toBe('old value');
      await expect(second).resolves.toBe('new value');
      await expect(profiles.get('p1')).resolves.toBe('new value');
    },
  );
});

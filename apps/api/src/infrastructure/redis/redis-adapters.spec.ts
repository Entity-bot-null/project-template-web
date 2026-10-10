import { describe, expect, it, vi } from 'vitest';
import { RedisCacheStore } from '../cache/cache.store.js';
import { IdempotencyService } from '../coordination/coordination.service.js';
import { RedisLeaseStore, RELEASE_SCRIPT } from '../coordination/lease.store.js';
import { RedisService, RedisUnavailableError } from './redis.service.js';
import type { RedisCommands } from './redis.types.js';

// The commands each Redis adapter sends: their options (TTL units, NX) are
// the whole point, and a wrong one would only show in production. The
// semantics against a real Redis are covered by redis.int.spec.ts.

function redisWith(commands: Partial<RedisCommands>, down = false) {
  return {
    run: vi.fn(async (operation: (redis: RedisCommands) => Promise<unknown>) => {
      if (down) throw new RedisUnavailableError('not connected');
      return operation(commands as RedisCommands);
    }),
  } as unknown as RedisService;
}

describe('RedisCacheStore', () => {
  it('writes with a TTL in seconds and reads null back as a miss', async () => {
    const set = vi.fn(() => Promise.resolve('OK'));
    const get = vi.fn(() => Promise.resolve(null));
    const store = new RedisCacheStore(redisWith({ set, get }));
    await store.set('k', 'v', 30);
    expect(set).toHaveBeenCalledWith('k', 'v', { expiration: { type: 'EX', value: 30 } });
    await expect(store.get('k')).resolves.toBeUndefined();
  });

  it('deletes and increments with single commands', async () => {
    const del = vi.fn(() => Promise.resolve(1));
    const incr = vi.fn(() => Promise.resolve(4));
    const store = new RedisCacheStore(redisWith({ del, incr }));
    await store.delete('k');
    expect(del).toHaveBeenCalledWith('k');
    await expect(store.increment('gen')).resolves.toBe(4);
  });

  it('lets RedisUnavailableError through for the cache to degrade', async () => {
    await expect(new RedisCacheStore(redisWith({}, true)).get('k')).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
  });
});

describe('RedisLeaseStore', () => {
  it('acquires with SET NX and a TTL in milliseconds', async () => {
    const set = vi.fn<RedisCommands['set']>(() => Promise.resolve('OK'));
    const store = new RedisLeaseStore(redisWith({ set }));
    const token = await store.acquire('lock:k', 5_000);
    expect(token).toEqual(expect.any(String));
    expect(set).toHaveBeenCalledWith('lock:k', token, {
      expiration: { type: 'PX', value: 5_000 },
      condition: 'NX',
    });
    set.mockResolvedValueOnce(null);
    await expect(store.acquire('lock:k', 5_000)).resolves.toBeNull();
  });

  it('releases through a compare-and-delete script, never blindly', async () => {
    const evalCommand = vi.fn<RedisCommands['eval']>(() => Promise.resolve(1));
    const store = new RedisLeaseStore(redisWith({ eval: evalCommand }));
    await expect(store.release('lock:k', 'token-1')).resolves.toBe(true);
    expect(evalCommand).toHaveBeenCalledWith(RELEASE_SCRIPT, {
      keys: ['lock:k'],
      arguments: ['token-1'],
    });
    evalCommand.mockResolvedValueOnce(0);
    await expect(store.release('lock:k', 'stale-token')).resolves.toBe(false);
  });

  it('releases its own claim when Redis applied the SET but answered after the deadline', async () => {
    const keys = new Map<string, string>();
    const commands: Partial<RedisCommands> = {
      set: (key, value) => {
        if (keys.has(key)) return Promise.resolve(null);
        keys.set(key, value);
        return Promise.resolve('OK');
      },
      eval: (_script, { keys: [key = ''], arguments: [token] }) => {
        if (keys.get(key) !== token) return Promise.resolve(0);
        keys.delete(key);
        return Promise.resolve(1);
      },
    };
    let late = true;
    const redis = {
      key: (...parts: string[]) => `app:${parts.join(':')}`,
      run: async (operation: (redis: RedisCommands) => Promise<unknown>) => {
        const result = await operation(commands as RedisCommands);
        if (late) {
          late = false;
          throw new RedisUnavailableError('no reply within 500 ms');
        }
        return result;
      },
    } as unknown as RedisService;
    const idempotency = new IdempotencyService(new RedisLeaseStore(redis), redis);
    await expect(idempotency.claim('webhooks', 'evt-1', 24 * 3600)).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    // The sender retries: nothing processed the event, so it is claimable again.
    await expect(idempotency.claim('webhooks', 'evt-1', 24 * 3600)).resolves.not.toBeNull();
  });
});

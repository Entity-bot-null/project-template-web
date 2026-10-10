import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { RedisService, RedisUnavailableError } from '../redis/redis.service.js';
import type { RedisCommands } from '../redis/redis.types.js';
import {
  InMemoryRateLimitStore,
  RedisRateLimitStore,
  SLIDING_WINDOW_SCRIPT,
  toRecord,
} from './rate-limit.store.js';

const TTL = 60_000;

/** A RedisService whose `run` hands the operation a fake connection, or fails. */
function fakeRedis(behavior: { eval?: () => Promise<unknown>; down?: boolean }) {
  const evalCommand = vi.fn<() => Promise<unknown>>(
    behavior.eval ?? (() => Promise.resolve([1, TTL, 0, 0])),
  );
  const redis = {
    key: (...parts: string[]) => `app:${parts.join(':')}`,
    run: vi.fn(async (operation: (commands: RedisCommands) => Promise<unknown>) => {
      if (behavior.down === true) throw new RedisUnavailableError('not connected');
      return operation({ eval: evalCommand } as unknown as RedisCommands);
    }),
  } as unknown as RedisService;
  return { redis, evalCommand };
}

let warn: MockInstance<Logger['warn']>;
let log: MockInstance<Logger['log']>;
const stores: { onApplicationShutdown(): void }[] = [];
beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const store of stores.splice(0)) store.onApplicationShutdown();
});

describe('InMemoryRateLimitStore', () => {
  it('counts hits per key and blocks past the limit, as the template always did', async () => {
    const store = new InMemoryRateLimitStore();
    stores.push(store);
    const hit = () => store.increment('client-a', TTL, 2, TTL, 'default');
    await expect(hit()).resolves.toMatchObject({ totalHits: 1, isBlocked: false });
    await expect(hit()).resolves.toMatchObject({ totalHits: 2, isBlocked: false });
    await expect(hit()).resolves.toMatchObject({ totalHits: 3, isBlocked: true });
    const other = await store.increment('client-b', TTL, 2, TTL, 'default');
    expect(other).toMatchObject({ totalHits: 1, isBlocked: false });
  });
});

describe('RedisRateLimitStore', () => {
  it('runs the sliding window script on keys hashed into one cluster slot', async () => {
    const { redis, evalCommand } = fakeRedis({
      eval: () => Promise.resolve([3, 59_400, 1, 58_001]),
    });
    const store = new RedisRateLimitStore(redis);
    stores.push(store);
    await expect(store.increment('k1', TTL, 2, 60_000, 'default')).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 60,
      isBlocked: true,
      timeToBlockExpire: 59,
    });
    const [script, call] = evalCommand.mock.calls[0] as unknown as [
      string,
      { keys: string[]; arguments: string[] },
    ];
    expect(script).toBe(SLIDING_WINDOW_SCRIPT);
    expect(call.keys).toEqual([
      'app:ratelimit:{default:k1}:hits',
      'app:ratelimit:{default:k1}:block',
      'app:ratelimit:{default:k1}:window',
    ]);
    expect(call.arguments.slice(0, 3)).toEqual(['60000', '2', '60000']);
  });

  it('falls back to per-instance counters while Redis is down, and says so once', async () => {
    const { redis } = fakeRedis({ down: true });
    const store = new RedisRateLimitStore(redis);
    stores.push(store);
    const results = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      results.push(await store.increment('k2', TTL, 2, TTL, 'default'));
    }
    // Still limiting, not failing open.
    expect(results.map((record) => record.isBlocked)).toEqual([false, false, true]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('per-instance counters');
  });

  it('goes back to Redis as soon as it answers', async () => {
    const behavior: { down: boolean } = { down: true };
    const { redis } = fakeRedis(behavior);
    const store = new RedisRateLimitStore(redis);
    stores.push(store);
    await store.increment('k3', TTL, 5, TTL, 'default');
    behavior.down = false;
    await expect(store.increment('k3', TTL, 5, TTL, 'default')).resolves.toMatchObject({
      totalHits: 1,
    });
    expect(log).toHaveBeenCalledWith('Rate limiting uses the shared Redis counters again');
  });

  it('does not hide a bug behind the fallback', async () => {
    const { redis } = fakeRedis({ eval: () => Promise.reject(new Error('ERR script error')) });
    const store = new RedisRateLimitStore(redis);
    stores.push(store);
    await expect(store.increment('k4', TTL, 5, TTL, 'default')).rejects.toThrow('ERR script error');
  });
});

describe('toRecord', () => {
  it('rejects a reply of the wrong shape', () => {
    expect(() => toRecord(['1', 2, 3, 4])).toThrow('Unexpected rate limit script reply');
    expect(() => toRecord(null)).toThrow();
    expect(toRecord([0, 1, 0, 0])).toEqual({
      totalHits: 0,
      timeToExpire: 1,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });
});

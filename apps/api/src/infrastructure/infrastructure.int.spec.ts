import { Logger } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { createClient } from '@redis/client';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../../test/app.js';
import { envelopeOf } from '../../test/http.js';
import {
  redisTestOptions,
  redisTestUrl,
  skipWithoutRedis,
  UNREACHABLE_REDIS_URL,
} from '../../test/redis.js';
import { SIGN_IN_RATE_LIMIT } from '../auth/auth.constants.js';
import { CacheService } from './cache/cache.service.js';
import { RedisCacheStore } from './cache/cache.store.js';
import { IdempotencyService, LockService } from './coordination/coordination.service.js';
import { RedisLeaseStore } from './coordination/lease.store.js';
import {
  InMemoryRateLimitStore,
  RATE_LIMIT_STORE,
  RedisRateLimitStore,
} from './rate-limit/rate-limit.store.js';
import { createRedisClient } from './redis/redis.client.js';
import { REDIS_OPTIONS } from './redis/redis.constants.js';
import { RedisService } from './redis/redis.service.js';
import type { RedisOptions } from './redis/redis.types.js';

// The Redis-backed adapters against a real Redis (test/redis.ts): the commands
// and scripts their unit specs can only fake, the sharing between instances
// that is their reason to exist, and the degraded mode when Redis is gone.

const prefixes: string[] = [];
const services: RedisService[] = [];
const apps: TestApp[] = [];

async function connectedRedis(overrides: Partial<RedisOptions> = {}): Promise<RedisService> {
  const options = redisTestOptions(overrides);
  prefixes.push(options.keyPrefix);
  const redis = new RedisService(options, createRedisClient);
  services.push(redis);
  redis.onModuleInit();
  await vi.waitFor(() => {
    expect(redis.status).toBe('ready');
  });
  return redis;
}

/** The application with its Redis-backed adapters on `options`. */
async function appWithRedis(options: RedisOptions, rateLimitOnRedis = true): Promise<TestApp> {
  const app = await createTestApp((builder: TestingModuleBuilder) => {
    const customized = builder.overrideProvider(REDIS_OPTIONS).useValue(options);
    return rateLimitOnRedis
      ? customized.overrideProvider(RATE_LIMIT_STORE).useFactory({
          factory: (redis: RedisService) => new RedisRateLimitStore(redis),
          inject: [RedisService],
        })
      : customized;
  });
  apps.push(app);
  return app;
}

function signInAttempt(app: TestApp) {
  return request(app.server)
    .post('/api/auth/sign-in')
    .send({ email: 'nobody@example.com', password: 'wrong-password' });
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.app.close();
  for (const redis of services.splice(0)) await redis.onModuleDestroy();
});

afterAll(async () => {
  if (redisTestUrl === undefined || prefixes.length === 0) return;
  // Only this run's keys: a development Redis keeps everything else.
  const client = createClient({ url: redisTestUrl });
  await client.connect();
  for (const prefix of prefixes) {
    for await (const keys of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) {
      if (keys.length > 0) await client.del(keys);
    }
  }
  await client.close();
});

describe.skipIf(skipWithoutRedis)('Redis-backed adapters (integration)', () => {
  it('connects, answers health checks, and keeps keys inside the prefix', async () => {
    const redis = await connectedRedis();
    await expect(redis.health()).resolves.toBe('ok');
    await redis.run((commands) => commands.set(redis.key('probe'), '1'));
    await expect(redis.run((commands) => commands.get(redis.key('probe')))).resolves.toBe('1');
    expect(redis.key('probe')).toMatch(/^it-[0-9a-f]{8}:probe$/);
  });

  it('limits exactly like the in-memory store: same hits, same blocks, same reset', async () => {
    const redisStore = new RedisRateLimitStore(await connectedRedis());
    const memoryStore = new InMemoryRateLimitStore();
    const run = async (store: RedisRateLimitStore | InMemoryRateLimitStore) => {
      const outcomes = [];
      for (let hit = 0; hit < 5; hit += 1) {
        const record = await store.increment('parity', 1_500, 3, 1_500, 'default');
        outcomes.push([record.totalHits, record.isBlocked]);
      }
      return outcomes;
    };
    const [fromRedis, fromMemory] = await Promise.all([run(redisStore), run(memoryStore)]);
    expect(fromRedis).toEqual(fromMemory);
    expect(fromRedis.map(([, blocked]) => blocked)).toEqual([false, false, false, true, true]);

    // The block ends after blockDuration; the first hit afterwards starts afresh.
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    const [afterRedis, afterMemory] = await Promise.all([
      redisStore.increment('parity', 1_500, 3, 1_500, 'default'),
      memoryStore.increment('parity', 1_500, 3, 1_500, 'default'),
    ]);
    expect([afterRedis.totalHits, afterRedis.isBlocked]).toEqual([1, false]);
    expect([afterMemory.totalHits, afterMemory.isBlocked]).toEqual([1, false]);
    memoryStore.onApplicationShutdown();
  });

  it('limits like the in-memory store without a block duration too (blockDuration 0)', async () => {
    // No block period: past the limit a hit is refused (and not counted) until
    // the oldest counted hit leaves the sliding window.
    const redisStore = new RedisRateLimitStore(await connectedRedis());
    const memoryStore = new InMemoryRateLimitStore();
    const run = async (store: RedisRateLimitStore | InMemoryRateLimitStore) => {
      const outcomes = [];
      for (let hit = 0; hit < 5; hit += 1) {
        const record = await store.increment('parity-no-block', 1_500, 3, 0, 'default');
        outcomes.push([record.totalHits, record.isBlocked, record.timeToBlockExpire > 0]);
      }
      return outcomes;
    };
    const [fromRedis, fromMemory] = await Promise.all([run(redisStore), run(memoryStore)]);
    expect(fromRedis).toEqual(fromMemory);
    expect(fromMemory).toEqual([
      [1, false, false],
      [2, false, false],
      [3, false, false],
      [4, true, true],
      [4, true, true],
    ]);

    // The window slides: once the counted hits expire, the next one is allowed.
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    const [afterRedis, afterMemory] = await Promise.all([
      redisStore.increment('parity-no-block', 1_500, 3, 0, 'default'),
      memoryStore.increment('parity-no-block', 1_500, 3, 0, 'default'),
    ]);
    expect([afterRedis.totalHits, afterRedis.isBlocked]).toEqual([1, false]);
    expect([afterMemory.totalHits, afterMemory.isBlocked]).toEqual([1, false]);
    memoryStore.onApplicationShutdown();
  });

  it('shares rate limits between instances: two APIs, one allowance', async () => {
    const options = redisTestOptions();
    prefixes.push(options.keyPrefix);
    const first = await appWithRedis(options);
    const second = await appWithRedis(options);
    for (const app of [first, second]) {
      await vi.waitFor(() => {
        expect(app.app.get(RedisService).status).toBe('ready');
      });
    }
    // The sign-in limit, split across both instances...
    for (let attempt = 0; attempt < SIGN_IN_RATE_LIMIT.limit; attempt += 1) {
      await signInAttempt(attempt % 2 === 0 ? first : second).expect(401);
    }
    // ...is used up for both.
    await signInAttempt(first).expect(429);
    await signInAttempt(second).expect(429);
  });

  it('caches with TTLs and invalidates for every instance sharing the store', async () => {
    const redis = await connectedRedis();
    const one = new CacheService(new RedisCacheStore(redis), redis).namespace<string>('profiles', {
      ttlSec: 1,
    });
    const two = new CacheService(new RedisCacheStore(redis), redis).namespace<string>('profiles', {
      ttlSec: 60,
    });
    await one.set('u1', 'Ada');
    await expect(two.get('u1')).resolves.toBe('Ada');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(two.get('u1')).resolves.toBeUndefined();

    await two.set('u2', 'Grace');
    await one.invalidate();
    await expect(two.get('u2')).resolves.toBeUndefined();
  });

  it('holds locks and idempotency claims across instances', async () => {
    const redis = await connectedRedis();
    const lockA = new LockService(new RedisLeaseStore(redis), redis);
    const lockB = new LockService(new RedisLeaseStore(redis), redis);
    let insideA!: () => void;
    const holding = lockA.withLock(
      'jobs:report',
      10_000,
      () =>
        new Promise<void>((resolve) => {
          insideA = resolve;
        }),
    );
    await vi.waitFor(() => {
      expect(insideA).toBeDefined();
    });
    await expect(lockB.withLock('jobs:report', 10_000, () => Promise.resolve())).resolves.toEqual({
      acquired: false,
    });
    insideA();
    await holding;
    await expect(lockB.withLock('jobs:report', 10_000, () => Promise.resolve(1))).resolves.toEqual({
      acquired: true,
      result: 1,
    });

    const claimsA = new IdempotencyService(new RedisLeaseStore(redis), redis);
    const claimsB = new IdempotencyService(new RedisLeaseStore(redis), redis);
    const ttls = { processingTtlSec: 60, doneTtlSec: 120 };
    const first = await claimsA.claim('webhooks:billing', 'evt_1', ttls);
    if (first.status !== 'claimed') throw new Error(`expected a claim, got ${first.status}`);
    // While A processes it, B's delivery must be retried later, not acknowledged.
    await expect(claimsB.claim('webhooks:billing', 'evt_1', ttls)).resolves.toEqual({
      status: 'in-progress',
    });
    await first.claim.complete();
    await expect(claimsB.claim('webhooks:billing', 'evt_1', ttls)).resolves.toEqual({
      status: 'done',
    });
    // Done for doneTtlSec, past the processing lease.
    const ttl = await redis.run((client) =>
      client.eval("return redis.call('PTTL', KEYS[1])", {
        keys: [redis.key('idempotency', 'webhooks:billing', 'evt_1')],
        arguments: [],
      }),
    );
    expect(ttl).toBeGreaterThan(60_000);
  });

  it('never lets a stale owner release a lease taken over by someone else', async () => {
    const redis = await connectedRedis();
    const store = new RedisLeaseStore(redis);
    const key = redis.key('lease');
    const first = await store.acquire(key, 100);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await store.acquire(key, 10_000);
    expect(second).not.toBeNull();
    await expect(store.release(key, first ?? '')).resolves.toBe(false);
    await expect(store.release(key, second ?? '')).resolves.toBe(true);
  });
});

// No Redis needed: these use one nobody listens on.
describe('Without Redis (integration)', () => {
  const unreachable = (overrides: Partial<RedisOptions> = {}): RedisOptions => ({
    url: UNREACHABLE_REDIS_URL,
    keyPrefix: 'it-down:',
    required: false,
    commandTimeoutMs: 200,
    production: false,
    ...overrides,
  });

  it('boots, serves, and reports readiness as degraded while an optional Redis is down', async () => {
    const t = await appWithRedis(unreachable());
    const res = await request(t.server).get('/api/health/ready').expect(200);
    expect(envelopeOf(res).data).toEqual({
      status: 'degraded',
      checks: { database: 'ok', redis: 'unavailable' },
    });
    await request(t.server).get('/api/health/live').expect(200);
  });

  it('keeps limiting with per-instance counters instead of failing open', async () => {
    const t = await appWithRedis(unreachable());
    for (let attempt = 0; attempt < SIGN_IN_RATE_LIMIT.limit; attempt += 1) {
      await signInAttempt(t).expect(401);
    }
    await signInAttempt(t).expect(429);
  });

  it('fails readiness when Redis is declared required', async () => {
    const t = await appWithRedis(unreachable({ required: true }), false);
    const res = await request(t.server).get('/api/health/ready').expect(503);
    expect(envelopeOf(res).message).toBe('Redis unreachable');
  });

  it('reports Redis as disabled when it is not configured', async () => {
    const t = await createTestApp();
    apps.push(t);
    const res = await request(t.server).get('/api/health/ready').expect(200);
    expect(envelopeOf(res).data).toEqual({
      status: 'ok',
      checks: { database: 'ok', redis: 'disabled' },
    });
  });
});

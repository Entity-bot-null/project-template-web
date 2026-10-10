import { describe, expect, it, vi } from 'vitest';
import { RedisService, RedisUnavailableError } from '../redis/redis.service.js';
import { IdempotencyService, LockService } from './coordination.service.js';
import { type LeaseStore, MemoryLeaseStore } from './lease.store.js';

const redisKeys = {
  key: (...parts: string[]) => `app:${parts.join(':')}`,
} as unknown as RedisService;

describe('MemoryLeaseStore', () => {
  it('gives a key to one owner until release or expiry', async () => {
    let now = 0;
    const store = new MemoryLeaseStore(() => now);
    const token = await store.acquire('k', 1_000);
    expect(token).toEqual(expect.any(String));
    await expect(store.acquire('k', 1_000)).resolves.toBeNull();
    await expect(store.release('k', 'someone-else')).resolves.toBe(false);
    now = 1_000;
    const next = await store.acquire('k', 1_000);
    expect(next).not.toBeNull();
    // The expired owner cannot release the new owner's lease.
    await expect(store.release('k', token ?? '')).resolves.toBe(false);
    await expect(store.release('k', next ?? '')).resolves.toBe(true);
  });
});

describe('LockService', () => {
  it('runs the work for one holder at a time and releases afterwards', async () => {
    const locks = new LockService(new MemoryLeaseStore(), redisKeys);
    let release!: () => void;
    const first = locks.withLock(
      'jobs:report',
      60_000,
      () =>
        new Promise<string>((resolve) => {
          release = () => {
            resolve('done');
          };
        }),
    );
    await expect(
      locks.withLock('jobs:report', 60_000, () => Promise.resolve('twice')),
    ).resolves.toEqual({
      acquired: false,
    });
    release();
    await expect(first).resolves.toEqual({ acquired: true, result: 'done' });
    await expect(
      locks.withLock('jobs:report', 60_000, () => Promise.resolve('again')),
    ).resolves.toEqual({
      acquired: true,
      result: 'again',
    });
  });

  it('releases the lock when the work fails, and keeps the error', async () => {
    const locks = new LockService(new MemoryLeaseStore(), redisKeys);
    await expect(
      locks.withLock('jobs:x', 1_000, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    await expect(locks.withLock('jobs:x', 1_000, () => Promise.resolve(1))).resolves.toMatchObject({
      acquired: true,
    });
  });

  it('fails closed while Redis is down: never "acquired" by default', async () => {
    const down: LeaseStore = {
      acquire: () => Promise.reject(new RedisUnavailableError('not connected')),
      release: () => Promise.resolve(false),
    };
    const work = vi.fn(() => Promise.resolve());
    await expect(
      new LockService(down, redisKeys).withLock('jobs:y', 1_000, work),
    ).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(work).not.toHaveBeenCalled();
  });

  it('rejects names that would collide or inject separators', async () => {
    const locks = new LockService(new MemoryLeaseStore(), redisKeys);
    await expect(locks.withLock('Bad Name', 1_000, () => Promise.resolve())).rejects.toThrow(
      'must match',
    );
  });
});

describe('IdempotencyService', () => {
  it('lets the first delivery through, drops duplicates, and allows a retry after a failure', async () => {
    const idempotency = new IdempotencyService(new MemoryLeaseStore(), redisKeys);
    const claim = await idempotency.claim('webhooks:billing', 'evt_1', 3_600);
    expect(claim).not.toBeNull();
    await expect(idempotency.claim('webhooks:billing', 'evt_1', 3_600)).resolves.toBeNull();
    await expect(idempotency.claim('webhooks:billing', 'evt_2', 3_600)).resolves.not.toBeNull();
    await claim?.release();
    await expect(idempotency.claim('webhooks:billing', 'evt_1', 3_600)).resolves.not.toBeNull();
  });
});

describe('MemoryLeaseStore memory', () => {
  it('drops expired leases: kept idempotency claims do not stay in memory forever', async () => {
    let now = 0;
    const store = new MemoryLeaseStore(() => now);
    const idempotency = new IdempotencyService(store, redisKeys);
    for (let i = 0; i < 10_000; i += 1) {
      await idempotency.claim('webhooks:billing', `evt_${String(i)}`, 60);
    }
    now += 24 * 60 * 60 * 1000;
    await idempotency.claim('webhooks:billing', 'evt_next', 60);
    const held = (store as unknown as { leases: Map<string, unknown> }).leases.size;
    expect(held).toBeLessThan(100);
  });

  it('keeps leases that are still alive', async () => {
    let now = 0;
    const store = new MemoryLeaseStore(() => now);
    const token = await store.acquire('job', 60_000);
    for (let i = 0; i < 500; i += 1) await store.acquire(`other-${String(i)}`, 1);
    now += 1_000;
    for (let i = 0; i < 200; i += 1) await store.acquire(`later-${String(i)}`, 1);
    await expect(store.acquire('job', 60_000)).resolves.toBeNull();
    await expect(store.release('job', token ?? '')).resolves.toBe(true);
  });
});

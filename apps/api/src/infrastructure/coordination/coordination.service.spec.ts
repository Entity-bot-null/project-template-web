import { describe, expect, it, vi } from 'vitest';
import { RedisService, RedisUnavailableError } from '../redis/redis.service.js';
import {
  type Claim,
  type ClaimOutcome,
  IdempotencyService,
  LockService,
} from './coordination.service.js';
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

  it('reads what a key holds, and replaces it whoever owned it', async () => {
    let now = 0;
    const store = new MemoryLeaseStore(() => now);
    const token = await store.acquire('k', 1_000);
    await expect(store.read('k')).resolves.toBe(token);
    await store.write('k', 'done', 5_000);
    await expect(store.read('k')).resolves.toBe('done');
    // The previous owner can no longer release it, nor can anyone acquire it.
    await expect(store.release('k', token ?? '')).resolves.toBe(false);
    await expect(store.acquire('k', 1_000)).resolves.toBeNull();
    now = 5_000;
    await expect(store.read('k')).resolves.toBeNull();
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
      read: () => Promise.reject(new RedisUnavailableError('not connected')),
      write: () => Promise.reject(new RedisUnavailableError('not connected')),
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
  const ttls = { processingTtlSec: 60, doneTtlSec: 24 * 3600 };
  const claimed = async (outcome: Promise<ClaimOutcome>): Promise<Claim> => {
    const result = await outcome;
    if (result.status !== 'claimed') throw new Error(`expected a claim, got ${result.status}`);
    return result.claim;
  };

  it('lets the first delivery through and skips one that comes after it was processed', async () => {
    const idempotency = new IdempotencyService(new MemoryLeaseStore(), redisKeys);
    const claim = await claimed(idempotency.claim('webhooks:billing', 'evt_1', ttls));
    await expect(idempotency.claim('webhooks:billing', 'evt_2', ttls)).resolves.toMatchObject({
      status: 'claimed',
    });
    await claim.complete();
    await expect(idempotency.claim('webhooks:billing', 'evt_1', ttls)).resolves.toEqual({
      status: 'done',
    });
  });

  // The provider stops retrying after a 2xx: a delivery that arrives while
  // the first is still being processed must not be acknowledged as done, or
  // the event is lost when that first attempt fails.
  it('answers a delivery that arrives during processing as in progress, never as done', async () => {
    const idempotency = new IdempotencyService(new MemoryLeaseStore(), redisKeys);
    const first = await claimed(idempotency.claim('webhooks:billing', 'evt_1', ttls));
    await expect(idempotency.claim('webhooks:billing', 'evt_1', ttls)).resolves.toEqual({
      status: 'in-progress',
    });
    await first.release(); // processing failed
    const retry = await claimed(idempotency.claim('webhooks:billing', 'evt_1', ttls));
    await retry.complete();
    // A release after the completion changes nothing.
    await retry.release();
    await expect(idempotency.claim('webhooks:billing', 'evt_1', ttls)).resolves.toEqual({
      status: 'done',
    });
  });

  it('gives the message of an attempt that crashed to a retry once its processing time is up', async () => {
    let now = 0;
    const idempotency = new IdempotencyService(new MemoryLeaseStore(() => now), redisKeys);
    await claimed(idempotency.claim('webhooks:billing', 'evt_1', ttls)); // never completed
    now += 59_000;
    await expect(idempotency.claim('webhooks:billing', 'evt_1', ttls)).resolves.toEqual({
      status: 'in-progress',
    });
    now += 1_000;
    const retry = await claimed(idempotency.claim('webhooks:billing', 'evt_1', ttls));
    await retry.complete();
    // Done for the long TTL, well past the processing one.
    now += 23 * 3600 * 1000;
    await expect(idempotency.claim('webhooks:billing', 'evt_1', ttls)).resolves.toEqual({
      status: 'done',
    });
    now += 3600 * 1000;
    await expect(idempotency.claim('webhooks:billing', 'evt_1', ttls)).resolves.toMatchObject({
      status: 'claimed',
    });
  });

  it('never fails a completion: the effect happened, and the sender must get its 2xx', async () => {
    const store = new MemoryLeaseStore();
    const idempotency = new IdempotencyService(
      Object.assign(store, {
        write: () => Promise.reject(new RedisUnavailableError('not connected')),
      }),
      redisKeys,
    );
    const claim = await claimed(idempotency.claim('webhooks:billing', 'evt_1', ttls));
    await expect(claim.complete()).resolves.toBeUndefined();
  });

  it('refuses TTLs that are not whole positive seconds', async () => {
    const idempotency = new IdempotencyService(new MemoryLeaseStore(), redisKeys);
    await expect(
      idempotency.claim('webhooks:billing', 'evt_1', { processingTtlSec: 0, doneTtlSec: 60 }),
    ).rejects.toThrow('whole seconds');
    await expect(
      idempotency.claim('webhooks:billing', 'evt_1', { processingTtlSec: 60, doneTtlSec: 1.5 }),
    ).rejects.toThrow('whole seconds');
  });
});

describe('MemoryLeaseStore memory', () => {
  it('drops expired leases: kept idempotency claims do not stay in memory forever', async () => {
    let now = 0;
    const store = new MemoryLeaseStore(() => now);
    const idempotency = new IdempotencyService(store, redisKeys);
    const ttls = { processingTtlSec: 60, doneTtlSec: 60 };
    for (let i = 0; i < 10_000; i += 1) {
      const outcome = await idempotency.claim('webhooks:billing', `evt_${String(i)}`, ttls);
      if (outcome.status === 'claimed') await outcome.claim.complete();
    }
    now += 24 * 60 * 60 * 1000;
    await idempotency.claim('webhooks:billing', 'evt_next', ttls);
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

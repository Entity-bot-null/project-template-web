import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailHealth, MailWorker } from '../infrastructure/mail/mail-worker.service.js';
import type { RedisHealth, RedisService } from '../infrastructure/redis/redis.service.js';
import { ShutdownState } from '../lifecycle/shutdown.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { HealthService } from './health.service.js';

function healthWith({
  database = () => Promise.resolve([1]),
  redis = () => Promise.resolve('disabled'),
  required = false,
  shutdown = new ShutdownState(),
  mail = 'disabled',
}: {
  database?: () => Promise<unknown>;
  redis?: () => Promise<RedisHealth>;
  required?: boolean;
  shutdown?: ShutdownState;
  mail?: MailHealth;
} = {}) {
  const fakeRedis = { health: redis, required } as unknown as RedisService;
  const fakeMail = { health: () => mail } as unknown as MailWorker;
  return new HealthService(
    { $queryRaw: database } as unknown as PrismaService,
    fakeRedis,
    shutdown,
    fakeMail,
  );
}

const redisIs = (health: RedisHealth) => () => Promise.resolve(health);
/** A dependency that stopped answering: connected, but the reply never comes. */
const never = () => new Promise<never>(() => undefined);

/** What `promise` settled with by now: 'pending' while it has not. */
function settlement(promise: Promise<unknown>): () => unknown {
  let outcome: unknown = 'pending';
  promise.then(
    (value) => {
      outcome = value;
    },
    (error: unknown) => {
      outcome = error;
    },
  );
  return () => outcome;
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HealthService', () => {
  it('reports liveness without touching any dependency', () => {
    const query = vi.fn();
    expect(healthWith({ database: query }).live()).toMatchObject({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('is ready when the database answers and Redis is not configured', async () => {
    await expect(healthWith().ready()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'ok', redis: 'disabled', mail: 'disabled' },
    });
  });

  it('answers 503 when the database does not', async () => {
    const service = healthWith({ database: () => Promise.reject(new Error('connection refused')) });
    await expect(service.ready()).rejects.toThrow(ServiceUnavailableException);
  });

  it('stays ready, degraded, when an optional Redis is down', async () => {
    await expect(healthWith({ redis: redisIs('unavailable') }).ready()).resolves.toEqual({
      status: 'degraded',
      checks: { database: 'ok', redis: 'unavailable', mail: 'disabled' },
    });
  });

  it('reports email: ok while delivering, degraded with a 200 when deliveries fail, never a 503', async () => {
    await expect(healthWith({ mail: 'ok' }).ready()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'ok', redis: 'disabled', mail: 'ok' },
    });
    await expect(healthWith({ mail: 'degraded' }).ready()).resolves.toEqual({
      status: 'degraded',
      checks: { database: 'ok', redis: 'disabled', mail: 'degraded' },
    });
  });

  it('answers 503 when a required Redis is down', async () => {
    await expect(
      healthWith({ redis: redisIs('unavailable'), required: true }).ready(),
    ).rejects.toThrow('Redis unreachable');
    await expect(
      healthWith({ redis: redisIs('ok'), required: true }).ready(),
    ).resolves.toMatchObject({
      status: 'ok',
    });
  });

  it('answers 503 once shutdown has begun, so no new traffic is routed here', async () => {
    const shutdown = new ShutdownState();
    shutdown.begin();
    await expect(healthWith({ shutdown }).ready()).rejects.toThrow('Shutting down');
  });

  it('answers 503 within 3 s when the database stops answering, instead of hanging the probe', async () => {
    vi.useFakeTimers();
    const outcome = settlement(healthWith({ database: never }).ready());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(outcome()).toBeInstanceOf(ServiceUnavailableException);
    expect(outcome()).toMatchObject({ message: 'Database unreachable' });
  });

  it('answers within 3 s when Redis stops answering: degraded, or 503 when required', async () => {
    vi.useFakeTimers();
    const optional = settlement(healthWith({ redis: never }).ready());
    const required = settlement(healthWith({ redis: never, required: true }).ready());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(optional()).toEqual({
      status: 'degraded',
      checks: { database: 'ok', redis: 'unavailable', mail: 'disabled' },
    });
    expect(required()).toMatchObject({ message: 'Redis unreachable' });
  });
});

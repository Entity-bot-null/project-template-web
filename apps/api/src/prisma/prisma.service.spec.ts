import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { poolConfig, PrismaService, slowQueryListener } from './prisma.service.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('slowQueryListener', () => {
  it('logs queries at or over the threshold, statement only', () => {
    const logger = { warn: vi.fn() };
    const listen = slowQueryListener(500, logger);
    listen({ duration: 499, query: 'SELECT 1' });
    expect(logger.warn).not.toHaveBeenCalled();
    listen({ duration: 812, query: 'SELECT "id" FROM "users" WHERE "email" = $1' });
    expect(logger.warn).toHaveBeenCalledWith(
      'Slow query (812 ms): SELECT "id" FROM "users" WHERE "email" = $1',
    );
  });

  it('cuts very long statements', () => {
    const logger = { warn: vi.fn() };
    slowQueryListener(1, logger)({ duration: 5, query: `SELECT ${'x, '.repeat(2_000)}1` });
    expect(String(logger.warn.mock.calls[0]?.[0]).length).toBeLessThan(1_100);
  });
});

describe('poolConfig', () => {
  it('bounds every wait on the database, and keeps idle connections alive', () => {
    expect(
      poolConfig('postgresql://app@db:5432/app', { poolMax: 7, statementTimeoutMs: 30_000 }),
    ).toEqual({
      connectionString: 'postgresql://app@db:5432/app',
      max: 7,
      // Waiting for a free connection, or for a new one to open.
      connectionTimeoutMillis: 5_000,
      // The server cancels a statement past this (a lock wait, a runaway query).
      statement_timeout: 30_000,
      // The client gives up a little later: a server that stopped answering
      // cannot cancel anything.
      query_timeout: 35_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
  });
});

describe('PrismaService at boot', () => {
  // With the pg adapter, $connect() only creates the pool: nothing reaches
  // the database until the first query.
  function bootingService(query: () => Promise<unknown>) {
    const service = new PrismaService();
    vi.spyOn(service, '$connect').mockResolvedValue(undefined);
    const probe = vi.spyOn(service, '$queryRaw').mockImplementation(query as never);
    return { service, probe };
  }

  it('checks that the database answers instead of trusting $connect()', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, probe } = bootingService(() => Promise.resolve([{ '?column?': 1 }]));
    await service.onModuleInit();
    expect(probe).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Database connected \(/));
  });

  it('says at boot that the database is unreachable, and boots anyway', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service } = bootingService(() =>
      Promise.reject(new Error("Can't reach database server at 127.0.0.1:1")),
    );
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Database unreachable at boot \(.*127\.0\.0\.1:1.*\): readiness answers 503 until it answers/,
      ),
    );
  });

  it('does not hold the boot for a database that never answers', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service } = bootingService(() => new Promise(() => undefined));
    let booted = false;
    void service.onModuleInit().then(() => {
      booted = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(booted).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no answer within'));
  });
});

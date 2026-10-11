import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyFailure, normalizeException } from '../common/filters/all-exceptions.filter.js';
import { env } from '../env/env.js';
import { PrismaClient } from './generated/client.js';
import { poolConfig } from './prisma.service.js';

// What the client really throws when the connection to PostgreSQL fails, not
// what PostgreSQL answers: a failover, a restart, a proxy or a network that
// drops the connection, or a server that stops answering. The pg driver
// raises these as plain errors that the Prisma adapter passes through as
// they are; the error filter must still count them as database failures
// (app.server.errors{error.origin="database"}, the ApiDatabaseErrors alert),
// never as a bug in the application.

/** A TCP hop between the client and the database that a test can cut or freeze. */
interface Hop {
  url: string;
  cut(): void;
  freeze(): void;
  close(): Promise<void>;
}

async function hop(databaseUrl: string): Promise<Hop> {
  const target = new URL(databaseUrl);
  const sockets: Socket[] = [];
  let frozen = false;
  const proxy = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    sockets.push(client, upstream);
    client.on('data', (chunk) => {
      if (!frozen) upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (!frozen) client.write(chunk);
    });
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const url = new URL(databaseUrl);
  url.hostname = '127.0.0.1';
  url.port = String((proxy.address() as AddressInfo).port);
  const cut = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    url: url.toString(),
    cut,
    freeze() {
      frozen = true;
    },
    close() {
      cut();
      return new Promise((resolve) => {
        proxy.close(() => {
          resolve();
        });
      });
    },
  };
}

/** Settles with what the query threw (undefined if it succeeded). */
function failureOf(query: Promise<unknown>): Promise<unknown> {
  return query.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('database connection failures (integration)', () => {
  const cleanup: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  /** The application's pool settings, through a hop. */
  function clientThrough(link: Hop, statementTimeoutMs = 30_000): PrismaClient {
    const prisma = new PrismaClient({
      adapter: new PrismaPg(poolConfig(link.url, { poolMax: 2, statementTimeoutMs })),
    });
    cleanup.push(() => prisma.$disconnect());
    return prisma;
  }

  async function connectedHop(): Promise<Hop> {
    const link = await hop(env.DATABASE_URL);
    cleanup.push(() => link.close());
    return link;
  }

  it('counts a connection dropped during a query as a database failure', async () => {
    const link = await connectedHop();
    const prisma = clientThrough(link);
    await prisma.$queryRaw`SELECT 1`;

    const failure = failureOf(prisma.$queryRaw`SELECT pg_sleep(30)`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    link.cut();
    const error = await failure;

    expect(error).toBeInstanceOf(Error);
    expect(classifyFailure(error)).toEqual({ origin: 'database', report: true });
    expect(normalizeException(error)).toEqual({
      status: 500,
      message: 'An unexpected error occurred',
    });
  });

  it('counts a database that stops answering during a query as a database failure', async () => {
    const link = await connectedHop();
    // The driver gives up 5 s after the statement timeout.
    const prisma = clientThrough(link, 100);
    await prisma.$queryRaw`SELECT 1`;

    link.freeze();
    const error = await failureOf(prisma.$queryRaw`SELECT 1`);

    expect(error).toBeInstanceOf(Error);
    expect(classifyFailure(error).origin).toBe('database');
  }, 15_000);

  it('counts a connection that never opens as a database failure', async () => {
    const link = await connectedHop();
    link.freeze();
    // Waits for the pool's connection timeout (5 s).
    const prisma = clientThrough(link);
    const error = await failureOf(prisma.$queryRaw`SELECT 1`);

    expect(error).toBeInstanceOf(Error);
    expect(classifyFailure(error).origin).toBe('database');
  }, 15_000);
});

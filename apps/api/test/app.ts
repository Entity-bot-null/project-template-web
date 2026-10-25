import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { onceMoreOnWriteConflict } from '../src/prisma/write-conflicts.js';

export interface TestApp {
  app: NestExpressApplication;
  prisma: PrismaService;
  /** The HTTP server for supertest. */
  server: Server;
}

// The real application with the production HTTP pipeline (configureApp), on
// the test database. Each suite creates its own, so in-memory state such as
// the rate limiter's counters never crosses suites. `customize` overrides
// providers, e.g. to point the Redis-backed adapters at the test Redis.
export async function createTestApp(
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<TestApp> {
  const moduleRef = await customize(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: ['warn', 'error'],
  });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService), server: app.getHttpServer() };
}

// Empties every table between tests, so no test sees another's rows. The
// table list is read from the database, so it never drifts from the schema.
// The suite's app keeps working meanwhile (its outbox workers claim, compose
// and sweep, locking rows of several tables), and TRUNCATE locks every table
// in turn: PostgreSQL may abort it as a deadlock's victim. Nothing of it
// committed, and the worker's transaction is done by then: it runs once more.
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const list = tables.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`).join(', ');
  // eslint-disable-next-line no-restricted-properties -- table names are identifiers, which no query can bind as parameters; each one comes from pg_tables and is quoted above
  await onceMoreOnWriteConflict(() => prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`));
}

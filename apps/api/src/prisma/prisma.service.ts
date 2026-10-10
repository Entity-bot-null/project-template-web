import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { withDeadline } from '../common/utils/deadline.js';
import { env } from '../env/env.js';
import { recordSlowQuery } from '../observability/metrics.js';
import { redactUrl } from '../observability/redact.js';
import { type Prisma, PrismaClient } from './generated/client.js';

// The one database client of the process. Every wait on the database is
// bounded (poolConfig), so a database that is unreachable, or connected but no
// longer answering, fails requests and the readiness check instead of hanging
// them. Closes on shutdown (app.enableShutdownHooks()).
//
// The boot does not wait for the database to come up: an API started during a
// database outage (or before the database, in a fresh stack) runs, answers
// readiness with 503 and serves as soon as the database answers, instead of
// crash-looping (docs/incident-response.md#3-database-unavailable). It checks
// once and says so in the log: with the pg adapter, $connect() only creates
// the pool, and nothing would otherwise reach the database before the first
// request.

/** Waiting for a free connection, or for a new one to open. pg's default is forever. */
const CONNECT_TIMEOUT_MS = 5_000;
// The client gives up on a query this long after the server should have
// cancelled it (statement_timeout): a server that stopped answering cannot
// cancel anything, and its connection is then dropped from the pool.
const QUERY_TIMEOUT_MARGIN_MS = 5_000;
// TCP keep-alive on idle connections: a peer that vanished (failover, NAT
// timeout) is noticed by the operating system instead of at the next query.
const KEEP_ALIVE_DELAY_MS = 10_000;

/**
 * The pg pool settings: every wait on the database is bounded. The adapter
 * passes them to pg as is; statement_timeout is sent to the server when each
 * connection opens (SHOW statement_timeout reads it back).
 */
export function poolConfig(
  connectionString: string,
  { poolMax, statementTimeoutMs }: { poolMax: number; statementTimeoutMs: number },
): ConstructorParameters<typeof PrismaPg>[0] {
  return {
    connectionString,
    max: poolMax,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs + QUERY_TIMEOUT_MARGIN_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEP_ALIVE_DELAY_MS,
  };
}

/** Statements are cut to this length in the slow query log. */
const MAX_LOGGED_STATEMENT = 1_000;

// Query events typed on: the slow query log listens to them.
type QueryEventOptions = Prisma.PrismaClientOptions & {
  log: { emit: 'event'; level: 'query' }[];
};

/**
 * Slow queries (docs/observability.md#database): the statement only, with its
 * placeholders ($1). Prisma passes the values separately; they are user data
 * and never logged.
 */
export function slowQueryListener(
  thresholdMs: number,
  logger: Pick<Logger, 'warn'>,
): (event: Pick<Prisma.QueryEvent, 'duration' | 'query'>) => void {
  return (event) => {
    if (event.duration < thresholdMs) return;
    recordSlowQuery();
    logger.warn(`Slow query (${event.duration} ms): ${event.query.slice(0, MAX_LOGGED_STATEMENT)}`);
  };
}

@Injectable()
export class PrismaService
  extends PrismaClient<QueryEventOptions>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger('Database');

  constructor() {
    super({
      adapter: new PrismaPg(
        poolConfig(env.DATABASE_URL, {
          poolMax: env.DB_POOL_MAX,
          statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
        }),
      ),
      log: env.DB_SLOW_QUERY_MS > 0 ? [{ emit: 'event', level: 'query' }] : [],
    });
    if (env.DB_SLOW_QUERY_MS > 0) {
      this.$on('query', slowQueryListener(env.DB_SLOW_QUERY_MS, this.logger));
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    const host = redactUrl(env.DATABASE_URL);
    try {
      await withDeadline(this.$queryRaw`SELECT 1`, CONNECT_TIMEOUT_MS + QUERY_TIMEOUT_MARGIN_MS);
      this.logger.log(`Database connected (${host})`);
    } catch (error) {
      this.logger.error(
        `Database unreachable at boot (${host}: ${describe(error)}): readiness answers 503 until it answers.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** An error on one line: Prisma's messages span several. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim();
}

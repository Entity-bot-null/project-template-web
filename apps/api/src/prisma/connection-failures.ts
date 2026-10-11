// Failures of the connection to PostgreSQL that reach the application as
// plain errors. The Prisma adapter turns what the database answers (SQLSTATE
// codes) and the usual socket errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT,
// ENOTFOUND) into Prisma errors, but passes these errors of the pg driver and
// its pool through unchanged: a connection dropped by a failover, a restart
// or a proxy, a server that stopped answering, a connection that never
// opened. Matched by their exact messages (pg 8, pg-pool 3), never by a part
// of them: an application error that happens to mention a connection is not
// a database failure. src/prisma/connection-failures.int.spec.ts produces
// each one against a real database.
const DRIVER_CONNECTION_FAILURES = new Set([
  // The socket closed under an active query (pg Client).
  'Connection terminated unexpectedly',
  // The client ended while queries were still waiting (pg Client).
  'Connection terminated',
  // No answer within query_timeout: statement_timeout plus a margin (pg Client).
  'Query read timeout',
  // A connection that failed earlier, used again (pg Client).
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
  // Opening a connection, or waiting for a free one, took longer than
  // connectionTimeoutMillis (pg-pool; the first one wraps the socket's error).
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
]);

/** How many causes deep a wrapped driver error is looked for. */
const MAX_CAUSE_DEPTH = 5;

/** True when the error, or one of its causes, is a lost or unopened database connection. */
export function isDatabaseConnectionFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (DRIVER_CONNECTION_FAILURES.has(current.message)) return true;
    current = current.cause;
  }
  return false;
}

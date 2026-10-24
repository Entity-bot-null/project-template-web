import { Prisma } from './generated/client.js';

// A transaction PostgreSQL aborted for a write conflict: a deadlock (40P01)
// or a serialization failure (40001). The pg adapter reports both as
// TransactionWriteConflict, which reaches the application as P2034 from a
// model query, and as P2010 ("raw query failed") with that kind in its meta
// from a raw one ($executeRaw, $queryRaw). src/prisma/write-conflicts.int.spec.ts
// produces one against a real database.
export function isWriteConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  if (error.code !== 'P2010') return false;
  const meta = error.meta as { driverAdapterError?: { cause?: { kind?: unknown } } } | undefined;
  return meta?.driverAdapterError?.cause?.kind === 'TransactionWriteConflict';
}

/**
 * Runs a transaction once more when PostgreSQL aborted it for a write
 * conflict: nothing of the aborted one committed, so it starts over. Only
 * for work that is safe to repeat as a whole (its side effects inside the
 * transaction, or after it).
 */
export async function onceMoreOnWriteConflict<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isWriteConflict(error)) return work();
    throw error;
  }
}

import { Prisma } from '../../prisma/generated/client.js';

/**
 * An error as a log line may carry it. Prisma's messages can quote the
 * query's arguments (an address, a name): its errors are logged by class and
 * code only. Other errors keep their message, which this code writes itself.
 */
export function errorSummary(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `${error.name} ${error.code}`;
  if (
    error instanceof Prisma.PrismaClientValidationError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientInitializationError
  ) {
    return error.name;
  }
  return error instanceof Error ? error.message : String(error);
}

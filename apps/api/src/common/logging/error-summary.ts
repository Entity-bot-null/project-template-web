// No import of the Prisma client: main.ts logs crashes with loggableStack
// before telemetry starts, and must load nothing instrumented by then. Prisma's
// errors are told by their class name (PrismaClientKnownRequestError, ...).

/**
 * An error as a log line may carry it. Prisma's messages can quote the
 * query's arguments (an address, a name): its errors are logged by class and
 * code only. Other errors keep their message, which this code writes itself.
 */
export function errorSummary(error: unknown): string {
  if (error instanceof Error && isPrismaError(error)) {
    const code = knownCode(error);
    return code === undefined ? error.name : `${error.name} ${code}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * An error's stack as a log line may carry it. A Prisma error's message (the
 * first lines, which can quote the query's arguments) gives way to its
 * summary; its frames stay.
 */
export function loggableStack(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (!isPrismaError(error)) return error.stack ?? `${error.name}: ${error.message}`;
  const frames = (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
  return [errorSummary(error), ...frames].join('\n');
}

/**
 * The error to report to the error tracker, a third party: a Prisma error is
 * replaced by one with its class, its code and its frames, and no message.
 * Any other error is reported as it is (and scrubbed again before it leaves).
 */
export function reportableError(error: unknown): unknown {
  if (!(error instanceof Error) || !isPrismaError(error)) return error;
  const safe = new Error(knownCode(error) ?? 'message withheld: it can quote query arguments');
  safe.name = error.name;
  safe.stack = loggableStack(error);
  return safe;
}

function isPrismaError(error: Error): boolean {
  return error.name.startsWith('PrismaClient');
}

/** A known request error's code (P2002...), the only part of it worth keeping. */
function knownCode(error: Error): string | undefined {
  if (error.name !== 'PrismaClientKnownRequestError' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

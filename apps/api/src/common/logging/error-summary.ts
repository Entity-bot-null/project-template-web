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
 * replaced by one with its class, its code and its frames, and no message,
 * wherever it is in the cause chain. Any other error is reported as it is
 * (and scrubbed again before it leaves).
 */
export function reportableError(error: unknown): unknown {
  return safeChain(error, 0);
}

/** How deep a cause chain is made safe (Sentry's own default limit is 5). */
const MAX_CAUSES = 5;

// Sentry's linkedErrorsIntegration reports an error's causes too, and the
// errors of an AggregateError: a Prisma error anywhere down is replaced, and
// an error above it copied with its safe causes and errors (never changed in
// place: the caller may still use it).
function safeChain(error: unknown, depth: number): unknown {
  if (!(error instanceof Error) || depth > MAX_CAUSES) return error;
  const cause: unknown = error.cause;
  const safeCause = cause === undefined ? undefined : safeChain(cause, depth + 1);
  const options = safeCause === undefined ? undefined : { cause: safeCause };
  if (isPrismaError(error)) {
    const safe = new Error(
      knownCode(error) ?? 'message withheld: it can quote query arguments',
      options,
    );
    safe.name = error.name;
    safe.stack = loggableStack(error);
    return safe;
  }
  const errors = error instanceof AggregateError ? (error.errors as unknown[]) : undefined;
  const safeErrors = errors?.map((inner) => safeChain(inner, depth + 1));
  const errorsChanged = safeErrors?.some((inner, index) => inner !== errors?.[index]) === true;
  if (safeCause === cause && !errorsChanged) return error;
  const copy =
    safeErrors === undefined
      ? new Error(error.message, options)
      : new AggregateError(safeErrors, error.message, options);
  copy.name = error.name;
  if (error.stack !== undefined) copy.stack = error.stack;
  return copy;
}

function isPrismaError(error: Error): boolean {
  return error.name.startsWith('PrismaClient');
}

/** A known request error's code (P2002...), the only part of it worth keeping. */
function knownCode(error: Error): string | undefined {
  if (error.name !== 'PrismaClientKnownRequestError' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

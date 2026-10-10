import { ConsoleLogger, type ConsoleLoggerOptions, type LogLevel } from '@nestjs/common';
import { type Env, LOG_LEVELS } from '../../env/env.schema.js';
import { correlationIds, currentRequestId } from '../../observability/request-context.js';
import { redact, redactText } from '../../observability/redact.js';

interface JsonLogOptions {
  context: string;
  logLevel: LogLevel;
  writeStreamType?: 'stdout' | 'stderr';
  errorStack?: unknown;
  params?: Record<string, unknown>;
  error?: Error;
}

/** Who wrote a log line: added to every JSON line, so a line is attributable on its own. */
export interface LogIdentity {
  service: string;
  environment: string;
  release: string;
}

// Nest's ConsoleLogger with two guarantees on top:
//   - redaction: every message, structured param, error and stack trace is
//     passed through observability/redact.ts before it is printed, so a
//     password, token, cookie or connection string handed to the logger by
//     mistake comes out masked (Nest's own `redact` option skips strings,
//     error messages and stacks, which is where credentials usually hide);
//   - correlation: JSON lines carry the service, environment and release, the
//     request id, and the trace and span ids while tracing is on.
export class AppLogger extends ConsoleLogger {
  constructor(
    private readonly identity: LogIdentity,
    options: ConsoleLoggerOptions,
  ) {
    super(options);
  }

  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
    params?: Record<string, unknown>,
  ): void {
    super.printMessages(
      // A lazy message (a function) is resolved here, so what it returns is
      // redacted like everything else (Nest would call it after redaction).
      messages.map((message) => redact(resolveLazy(message))),
      context,
      logLevel,
      writeStreamType,
      typeof errorStack === 'string' ? redactText(errorStack) : redact(errorStack),
      params === undefined ? undefined : redact(params),
    );
  }

  // Nest calls this with undefined when there is no stack, whatever its signature says.
  protected override printStackTrace(stack: string | undefined): void {
    if (stack !== undefined) super.printStackTrace(redactText(stack));
  }

  protected override getJsonLogObject(message: unknown, options: JsonLogOptions) {
    return {
      ...super.getJsonLogObject(message, options),
      ...this.identity,
      ...correlationIds(),
    };
  }

  // Text lines (development) name the request too.
  protected override formatContext(context: string): string {
    const requestId = currentRequestId();
    const formatted = super.formatContext(context);
    return requestId === undefined ? formatted : `${formatted}(req ${requestId}) `;
  }
}

/**
 * The value of a lazy log message: Nest accepts a function and prints what it
 * returns (a class is printed by its name, so it is left as it is).
 */
function resolveLazy(message: unknown): unknown {
  if (typeof message !== 'function') return message;
  if (Function.prototype.toString.call(message).startsWith('class ')) return message;
  return (message as () => unknown)();
}

// One logger for the whole process. JSON (one object per line, ready for any
// log collector) in production, readable text elsewhere. LOG_LEVEL enables
// that level and every more severe one.
export function createLogger(
  env: Pick<
    Env,
    'LOG_LEVEL' | 'LOG_FORMAT' | 'APP_ENVIRONMENT' | 'APP_RELEASE' | 'OTEL_SERVICE_NAME'
  >,
): AppLogger {
  const json = env.LOG_FORMAT === 'json';
  return new AppLogger(
    { service: env.OTEL_SERVICE_NAME, environment: env.APP_ENVIRONMENT, release: env.APP_RELEASE },
    {
      json,
      colors: !json,
      logLevels: LOG_LEVELS.slice(0, LOG_LEVELS.indexOf(env.LOG_LEVEL) + 1),
    },
  );
}

import type { Env } from '../env/env.schema.js';
import type { ErrorOrigin } from './metrics.js';

// Error tracking (docs/observability.md#error-tracking): where an unexpected
// error goes besides the log, so it is grouped, counted per release and
// alerted on. OPTIONAL: without SENTRY_DSN the tracker is a no-op and the
// Sentry SDK is never loaded.
//
// What is reported: unexpected errors (a 500 from the error filter, a failed
// dependency) and process crashes. Not reported: expected outcomes (4xx,
// deliberate 503s such as a failing readiness check), which are metrics and
// log lines, not bugs. Only what is passed here is sent: no request headers,
// cookies or bodies (docs/security.md#error-tracking-data).

export interface ErrorContext {
  level?: 'error' | 'fatal';
  origin?: ErrorOrigin | 'process';
  /** The failing external service, when origin is "dependency". */
  dependency?: string;
  requestId?: string;
  method?: string;
  /** The route pattern (/api/users/:id), never the concrete path. */
  route?: string;
  statusCode?: number;
  /** An opaque id, never an email or a name. */
  userId?: string;
}

export interface ErrorTracker {
  readonly enabled: boolean;
  capture(error: unknown, context?: ErrorContext): void;
  /** Waits until queued reports are sent, at most `timeoutMs`. */
  flush(timeoutMs: number): Promise<void>;
  /** Flushes, then stops sending. */
  close(timeoutMs: number): Promise<void>;
}

export const disabledErrorTracker: ErrorTracker = {
  enabled: false,
  capture: () => undefined,
  flush: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

let current: ErrorTracker = disabledErrorTracker;

/** The process-wide tracker: the configured one after startErrorTracking, else a no-op. */
export function errorTracker(): ErrorTracker {
  return current;
}

/** Replaces the process-wide tracker (tests). */
export function setErrorTracker(tracker: ErrorTracker): void {
  current = tracker;
}

export async function startErrorTracking(
  env: Pick<Env, 'SENTRY_DSN' | 'SENTRY_SAMPLE_RATE' | 'APP_ENVIRONMENT' | 'APP_RELEASE'>,
): Promise<ErrorTracker> {
  if (env.SENTRY_DSN === undefined) return current;
  const { createSentryTracker } = await import('./sentry.js');
  current = createSentryTracker({
    dsn: env.SENTRY_DSN,
    environment: env.APP_ENVIRONMENT,
    release: env.APP_RELEASE,
    sampleRate: env.SENTRY_SAMPLE_RATE,
  });
  return current;
}

import { createLogger } from './common/logging/logger.js';
import { env } from './env/env.js';
import { errorTracker, startErrorTracking } from './observability/error-tracker.js';
import { startTelemetry } from './observability/telemetry.js';

// Entry point. Observability starts before the application is imported: the
// OpenTelemetry instrumentations patch http, express and pg when those are
// first loaded, so the application (server.ts) is loaded afterwards, with a
// dynamic import. Keep the static imports above free of anything instrumented.

const logger = createLogger(env);
const FATAL_FLUSH_TIMEOUT_MS = 2_000;

// An error that no request handler caught leaves the process in an unknown
// state: log it in the standard format (with its stack), report it, and exit,
// so the orchestrator restarts a clean process instead of serving from a
// broken one. The exit waits for the report at most FATAL_FLUSH_TIMEOUT_MS.
let crashing = false;
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (error: unknown) => {
    logger.fatal(
      `${event}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    if (crashing) return;
    crashing = true;
    errorTracker().capture(error, { level: 'fatal', origin: 'process' });
    setTimeout(() => process.exit(1), FATAL_FLUSH_TIMEOUT_MS + 500).unref();
    void errorTracker()
      .flush(FATAL_FLUSH_TIMEOUT_MS)
      .finally(() => process.exit(1));
  });
}

const telemetry = await startTelemetry(env);
const tracker = await startErrorTracking(env);
logger.log(
  `Starting release ${env.APP_RELEASE} in ${env.APP_ENVIRONMENT}: tracing and metrics ${telemetry.enabled ? 'on' : 'off'}, error tracking ${tracker.enabled ? 'on' : 'off'}, Redis ${env.REDIS_URL === undefined ? 'off' : 'on'}`,
  'Bootstrap',
);

const { startServer } = await import('./server.js');
await startServer(logger);

import { loadRuntimeConfig, type RuntimeConfig } from './runtimeConfig';

// Error tracking in the browser (docs/observability.md#error-tracking).
// OPTIONAL: without a DSN in /app-config.json nothing is loaded and errors only
// reach the console. With one, the Sentry SDK is fetched as a separate chunk
// after the app has rendered, and it captures uncaught errors and unhandled
// rejections from then on; errors from before it loaded are kept (a few) and
// sent once it is ready.

export interface ErrorReport {
  /** Where the error was caught: "route", "window", a component name. */
  source: string;
}

export type Reporter = (error: unknown, report: ErrorReport) => void;

const MAX_EARLY_ERRORS = 10;
const early: { error: unknown; report: ErrorReport }[] = [];
let reporter: Reporter | undefined;
/** False once the deployment turned out to have no error tracking. */
let keeping = true;

/** Sends an error to the tracker, when there is one; keeps it until then. */
export function reportError(error: unknown, report: ErrorReport): void {
  if (reporter !== undefined) {
    reporter(error, report);
  } else if (keeping && early.length < MAX_EARLY_ERRORS) {
    early.push({ error, report });
  }
}

const onWindowError = (event: ErrorEvent) => {
  reportError(event.error ?? event.message, { source: 'window' });
};
const onRejection = (event: PromiseRejectionEvent) => {
  reportError(event.reason, { source: 'unhandledrejection' });
};

export interface StartOptions {
  loadConfig?: () => Promise<RuntimeConfig>;
  loadSdk?: () => Promise<{ initSentry: (config: InitConfig) => Reporter }>;
}

export interface InitConfig {
  dsn: string;
  sampleRate: number;
  environment: string;
  release: string;
}

/** Starts error tracking if the deployment configured it. Never throws. */
export async function startErrorTracking({
  loadConfig = loadRuntimeConfig,
  loadSdk = () => import('./sentry'),
}: StartOptions = {}): Promise<boolean> {
  // Until the SDK takes over, errors are kept for it.
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onRejection);
  try {
    const config = await loadConfig();
    if (config.errorTracking === undefined) return false;
    const { initSentry } = await loadSdk();
    const send = initSentry({
      ...config.errorTracking,
      environment: config.environment,
      release: config.release,
    });
    reporter = send;
    for (const { error, report } of early.splice(0)) send(error, report);
    return true;
  } catch (error) {
    console.error('Error tracking could not start', error);
    return false;
  } finally {
    // From here on the SDK has its own handlers, or there is nothing to keep for.
    if (reporter === undefined) {
      keeping = false;
      early.length = 0;
    }
    window.removeEventListener('error', onWindowError);
    window.removeEventListener('unhandledrejection', onRejection);
  }
}

/** Back to the initial state (specs). */
export function resetErrorTracking(): void {
  reporter = undefined;
  keeping = true;
  early.length = 0;
}

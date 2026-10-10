// Settings that differ between deployments of the same build, read at runtime
// from /app-config.json: one image runs in staging and in production. The web
// server writes the file from its environment at start (apps/web/nginx), the
// dev and preview servers from theirs (vite.config.ts). Never a secret here:
// the file is public, like the bundle.

export interface RuntimeConfig {
  environment: string;
  release: string;
  /** Error tracking is on only with a DSN (docs/observability.md#error-tracking). */
  errorTracking?: { dsn: string; sampleRate: number };
  /** Share of page loads that report Web Vitals; absent when none (docs/observability.md#web-vitals). */
  webVitals?: { sampleRate: number };
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  environment: 'development',
  release: 'unversioned',
};

const CONFIG_URL = '/app-config.json';
const TIMEOUT_MS = 3_000;

let shared: Promise<RuntimeConfig> | undefined;

/** The deployment's settings, fetched once per page load for everything that reads them. */
export function runtimeConfig(): Promise<RuntimeConfig> {
  return (shared ??= loadRuntimeConfig());
}

/** The deployment's settings; the defaults (everything optional off) on any problem. */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const response = await fetch(new URL(CONFIG_URL, window.location.origin), {
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return DEFAULT_RUNTIME_CONFIG;
    return parseRuntimeConfig(await response.json());
  } catch {
    return DEFAULT_RUNTIME_CONFIG;
  }
}

/**
 * Validates the file's shape: `sentryDsn` empty means error tracking off,
 * `webVitalsSampleRate` 0 (or anything but a number up to 1) Web Vitals off.
 */
export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_RUNTIME_CONFIG;
  const fields = raw as Record<string, unknown>;
  const text = (key: string, fallback: string) => {
    const value = fields[key];
    return typeof value === 'string' && value.length > 0 ? value : fallback;
  };
  const config: RuntimeConfig = {
    environment: text('environment', DEFAULT_RUNTIME_CONFIG.environment),
    release: text('release', DEFAULT_RUNTIME_CONFIG.release),
  };
  const dsn = text('sentryDsn', '');
  const sampleRate = Number(text('sentrySampleRate', '1'));
  if (dsn.startsWith('https://') || dsn.startsWith('http://')) {
    config.errorTracking = {
      dsn,
      sampleRate:
        Number.isFinite(sampleRate) && sampleRate >= 0 && sampleRate <= 1 ? sampleRate : 1,
    };
  }
  const vitalsRate = Number(text('webVitalsSampleRate', '0'));
  if (vitalsRate > 0 && vitalsRate <= 1) config.webVitals = { sampleRate: vitalsRate };
  return config;
}

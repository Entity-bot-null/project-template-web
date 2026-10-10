import type { Env } from '../env/env.schema.js';

// Tracing and metrics with OpenTelemetry (docs/observability.md#opentelemetry).
// OPTIONAL: on only when OTEL_EXPORTER_OTLP_ENDPOINT is set (and
// OTEL_SDK_DISABLED is not true). Off, the SDK is never imported: no patched
// modules, no exporters, no overhead in development or tests.
//
// main.ts starts telemetry before the application is imported, because the
// instrumentations patch http, express and pg when those are first loaded.

export interface Telemetry {
  readonly enabled: boolean;
  /** Exports buffered spans and metrics now. */
  flush(): Promise<void>;
  /** Flushes, then stops exporting. */
  shutdown(): Promise<void>;
}

const disabled: Telemetry = {
  enabled: false,
  flush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

let current: Telemetry = disabled;

/** The running telemetry (a no-op when off), for the shutdown sequence. */
export function telemetry(): Telemetry {
  return current;
}

export type TelemetrySettings = Pick<
  Env,
  | 'OTEL_EXPORTER_OTLP_ENDPOINT'
  | 'OTEL_SDK_DISABLED'
  | 'OTEL_SERVICE_NAME'
  | 'OTEL_METRIC_EXPORT_INTERVAL'
  | 'APP_ENVIRONMENT'
  | 'APP_RELEASE'
>;

export function telemetryEnabled(settings: TelemetrySettings): boolean {
  return settings.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined && settings.OTEL_SDK_DISABLED !== true;
}

export async function startTelemetry(settings: TelemetrySettings): Promise<Telemetry> {
  const endpoint = settings.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined || !telemetryEnabled(settings)) return current;
  const { startOpenTelemetry } = await import('./telemetry-sdk.js');
  current = startOpenTelemetry({
    endpoint,
    serviceName: settings.OTEL_SERVICE_NAME,
    environment: settings.APP_ENVIRONMENT,
    release: settings.APP_RELEASE,
    metricExportIntervalMs: settings.OTEL_METRIC_EXPORT_INTERVAL,
  });
  return current;
}

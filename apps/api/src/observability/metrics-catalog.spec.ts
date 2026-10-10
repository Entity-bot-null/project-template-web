import { context, metrics, propagation, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recordCacheRead,
  recordDegradation,
  recordDependencyCall,
  recordServerError,
  recordSlowQuery,
} from './metrics.js';
import { startOpenTelemetry } from './telemetry-sdk.js';

// observability/api-metrics.json lists the series the dashboards and alert
// rules may read (scripts/check-observability.mjs). It is rewritten from a
// running backend (docs/observability.md#metric-catalog); this spec keeps it
// true to the code in between: every metric the process creates is listed
// under the name Prometheus gives it, with its type, and the application's
// own metrics (app_*, process_*) are listed with exactly their attributes,
// no more and no fewer. A metric renamed or removed in the code fails here,
// before a dashboard or an alert silently reads nothing.

interface CatalogEntry {
  type: 'counter' | 'gauge' | 'histogram';
  labels: string[];
}

const catalog = JSON.parse(
  readFileSync(new URL('../../../../observability/api-metrics.json', import.meta.url), 'utf8'),
) as { metrics: Record<string, CatalogEntry> };

/** Units the API's instruments use, as Prometheus spells them in names. */
const UNIT_SUFFIXES: Readonly<Record<string, string>> = {
  s: 'seconds',
  ms: 'milliseconds',
  By: 'bytes',
};

/**
 * The name Prometheus stores an OpenTelemetry metric under (its OTLP
 * translation, UnderscoreEscapingWithSuffixes): dots to underscores, the
 * unit as a suffix ("1" only on gauges, as "ratio"; annotations such as
 * "{connection}" dropped), and "_total" on counters.
 */
export function prometheusName(name: string, unit: string, type: CatalogEntry['type']): string {
  let result = name.replace(/[^a-zA-Z0-9_:]/g, '_');
  let suffix: string | undefined;
  if (unit === '' || /^\{.*\}$/.test(unit)) suffix = '';
  else if (unit === '1') suffix = type === 'gauge' ? 'ratio' : '';
  else suffix = UNIT_SUFFIXES[unit];
  if (suffix === undefined) {
    throw new Error(`No Prometheus suffix known for the unit "${unit}" of ${name}: add it here`);
  }
  if (suffix !== '' && !result.endsWith(`_${suffix}`)) result += `_${suffix}`;
  if (type === 'counter' && !result.endsWith('_total')) result += '_total';
  return result;
}

function typeOf(metric: MetricData): CatalogEntry['type'] {
  if (metric.dataPointType === DataPointType.HISTOGRAM) return 'histogram';
  if (metric.dataPointType === DataPointType.SUM && metric.isMonotonic) return 'counter';
  return 'gauge';
}

/** Attribute keys of every data point, as label names. */
function labelsOf(metric: MetricData): string[] {
  const keys = new Set<string>();
  for (const point of metric.dataPoints) {
    for (const key of Object.keys(point.attributes)) keys.add(key.replace(/[^a-zA-Z0-9_]/g, '_'));
  }
  return [...keys].sort();
}

afterEach(() => {
  // Leave the global API as an unconfigured process has it.
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
});

describe('observability/api-metrics.json', () => {
  it('lists the metrics the API creates under their Prometheus names, app metrics with their exact attributes', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const telemetry = startOpenTelemetry({
      endpoint: 'http://127.0.0.1:4318',
      serviceName: 'api',
      environment: 'test',
      release: 'r1',
      metricExportIntervalMs: 60_000,
      spanExporter: new InMemorySpanExporter(),
      metricExporter: exporter,
    });
    try {
      // Every application metric once, every optional attribute set.
      recordServerError('database', '/api/things');
      recordDependencyCall('billing', 'http_error', 0.2, 503);
      recordCacheRead('profiles', 'hit');
      recordDegradation('cache', 'redis');
      recordSlowQuery();
      await telemetry.flush();

      const exported = exporter
        .getMetrics()
        .flatMap((resource) => resource.scopeMetrics)
        .flatMap(({ scope, metrics: scoped }) =>
          scoped.map((metric) => ({ scope: scope.name, metric })),
        );
      const names = exported.map(({ metric }) => {
        const type = typeOf(metric);
        const name = prometheusName(metric.descriptor.name, metric.descriptor.unit, type);
        expect({ name, entry: catalog.metrics[name] }).toEqual({
          name,
          entry: expect.objectContaining({ type }) as CatalogEntry,
        });
        return name;
      });
      // The runtime instrumentation's metrics are checked too, not only ours.
      expect(names.filter((name) => /^(nodejs|v8js)_/.test(name))).not.toEqual([]);

      const own = exported.filter(({ scope }) => scope.startsWith('app'));
      const fromCode = Object.fromEntries(
        own.map(({ metric }) => [
          prometheusName(metric.descriptor.name, metric.descriptor.unit, typeOf(metric)),
          { type: typeOf(metric), labels: labelsOf(metric) },
        ]),
      );
      const listed = Object.fromEntries(
        Object.entries(catalog.metrics).filter(
          ([name]) => name.startsWith('app_') || name.startsWith('process_'),
        ),
      );
      expect(fromCode).toEqual(listed);
    } finally {
      await telemetry.shutdown();
    }
  });
});

describe('prometheusName', () => {
  it('follows the OTLP translation of Prometheus', () => {
    expect(prometheusName('http.server.request.duration', 's', 'histogram')).toBe(
      'http_server_request_duration_seconds',
    );
    expect(prometheusName('app.server.errors', '', 'counter')).toBe('app_server_errors_total');
    expect(prometheusName('process.memory.usage', 'By', 'gauge')).toBe(
      'process_memory_usage_bytes',
    );
    expect(prometheusName('nodejs.eventloop.utilization', '1', 'gauge')).toBe(
      'nodejs_eventloop_utilization_ratio',
    );
    expect(prometheusName('db.client.connection.count', '{connection}', 'gauge')).toBe(
      'db_client_connection_count',
    );
    expect(() => prometheusName('x', 'furlongs', 'gauge')).toThrow(/furlongs/);
  });
});

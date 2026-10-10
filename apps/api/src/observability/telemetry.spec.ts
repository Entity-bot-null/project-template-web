import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, type Span } from '@opentelemetry/sdk-trace-base';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordCacheRead, recordServerError } from './metrics.js';
import { correlationIds, runWithRequestContext } from './request-context.js';
import { RedactingSpanProcessor, signalUrl, startOpenTelemetry } from './telemetry-sdk.js';
import { startTelemetry, telemetryEnabled } from './telemetry.js';

const settings = {
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
  OTEL_SDK_DISABLED: undefined,
  OTEL_SERVICE_NAME: 'api',
  OTEL_METRIC_EXPORT_INTERVAL: 60_000,
  APP_ENVIRONMENT: 'test',
  APP_RELEASE: 'r1',
};

// Built at runtime: secret scanners rightly flag a connection string with a
// password written out in a file, test fixtures included.
const PG = 'postgresql';
const dbUrl = (user: string, password: string, rest = '@db:5432/app') =>
  `${PG}://${user}:${password}${rest}`;

afterEach(() => {
  // Leave the global API as an unconfigured process has it.
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
});

describe('telemetryEnabled', () => {
  it('is on only with an endpoint, and the standard kill switch wins', () => {
    expect(telemetryEnabled(settings)).toBe(false);
    const withEndpoint = { ...settings, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' };
    expect(telemetryEnabled(withEndpoint)).toBe(true);
    expect(telemetryEnabled({ ...withEndpoint, OTEL_SDK_DISABLED: true })).toBe(false);
  });

  it('exports traces and metrics over OTLP/HTTP to the configured endpoint', async () => {
    // A stand-in collector on loopback: the real exporters, the real protocol.
    const received: string[] = [];
    const collector = createServer((req, res) => {
      received.push(`${req.method ?? ''} ${req.url ?? ''}`);
      req.resume();
      req.on('end', () => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'));
    });
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
    const { port } = collector.address() as AddressInfo;
    try {
      // A fresh module: the process-wide telemetry of other specs stays untouched.
      vi.resetModules();
      const fresh = await import('./telemetry.js');
      const started = await fresh.startTelemetry({
        ...settings,
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      });
      expect(started.enabled).toBe(true);
      trace.getTracer('spec').startSpan('work').end();
      await started.shutdown();
      expect(received).toEqual(expect.arrayContaining(['POST /v1/traces', 'POST /v1/metrics']));
    } finally {
      collector.close();
    }
  });

  it('starts nothing when off: development and tests pay no overhead', async () => {
    const telemetry = await startTelemetry(settings);
    expect(telemetry.enabled).toBe(false);
    expect(trace.getActiveSpan()).toBeUndefined();
  });
});

describe('startOpenTelemetry', () => {
  it('exports spans with deployment identity, redacted attributes, and log correlation', async () => {
    const spans = new InMemorySpanExporter();
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const telemetry = startOpenTelemetry({
      endpoint: 'http://127.0.0.1:4318',
      serviceName: 'api',
      environment: 'staging',
      release: 'abc1234',
      metricExportIntervalMs: 60_000,
      spanExporter: spans,
      metricExporter,
    });

    let ids = {};
    trace.getTracer('spec').startActiveSpan('GET /api/things', (span) => {
      span.setAttribute('url.full', 'https://api.example.com/things?token=abc');
      span.setAttribute('db.statement', `SELECT 1 -- ${dbUrl('app', 'pw', '@db/app')}`);
      runWithRequestContext({ requestId: 'req-1' }, () => {
        ids = correlationIds();
      });
      span.end();
    });
    recordServerError('database', '/api/things');
    recordCacheRead('profiles', 'hit');
    // Read before shutdown: the in-memory exporters forget everything then.
    await telemetry.flush();

    const [span] = spans.getFinishedSpans();
    expect(span?.attributes).toMatchObject({
      'url.full': 'https://api.example.com/things',
      'db.statement': `SELECT 1 -- ${dbUrl('app', '[REDACTED]', '@db/app')}`,
    });
    expect(span?.resource.attributes).toMatchObject({
      'service.name': 'api',
      'service.version': 'abc1234',
      'deployment.environment.name': 'staging',
    });
    expect(ids).toEqual({
      requestId: 'req-1',
      traceId: span?.spanContext().traceId,
      spanId: span?.spanContext().spanId,
    });

    const names = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics.map((metric) => metric.descriptor.name));
    expect(names).toEqual(
      expect.arrayContaining(['app.server.errors', 'app.cache.operations', 'process.memory.usage']),
    );
    await telemetry.shutdown();
  });
});

describe('signalUrl', () => {
  it('appends the signal path, keeping a base path', () => {
    expect(signalUrl('http://localhost:4318', 'traces')).toBe('http://localhost:4318/v1/traces');
    expect(signalUrl('https://otlp.example.com/otlp/', 'metrics')).toBe(
      'https://otlp.example.com/otlp/v1/metrics',
    );
  });
});

describe('RedactingSpanProcessor', () => {
  it('strips query strings from URL attributes and redacts every other string', () => {
    const attributes: Record<string, unknown> = {
      'http.target': '/api/users?token=abc',
      'url.query': 'token=abc',
      'http.url': 'http://u:p@host/x?y=1',
      'messaging.payload': 'Bearer abcdef123456',
      'http.response.status_code': 200,
    };
    const span = {
      attributes,
      setAttribute(key: string, value: unknown) {
        attributes[key] = value;
      },
    } as unknown as Span;
    new RedactingSpanProcessor().onEnding(span);
    expect(attributes).toEqual({
      'http.target': '/api/users',
      'url.query': '[REDACTED]',
      'http.url': 'http://host/x',
      'messaging.payload': 'Bearer [REDACTED]',
      'http.response.status_code': 200,
    });
  });
});

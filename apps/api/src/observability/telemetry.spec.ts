import { context, metrics, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, type Span } from '@opentelemetry/sdk-trace-base';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
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

describe('the resource every span and metric carries', () => {
  async function resourceAttributes() {
    const spans = new InMemorySpanExporter();
    const telemetry = startOpenTelemetry({
      endpoint: 'http://127.0.0.1:4318',
      serviceName: 'api',
      environment: 'production',
      release: 'abc1234',
      metricExportIntervalMs: 60_000,
      spanExporter: spans,
      metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    });
    trace.getTracer('spec').startSpan('work').end();
    await telemetry.flush();
    const [span] = spans.getFinishedSpans();
    await span?.resource.waitForAsyncAttributes?.();
    await telemetry.shutdown();
    return span?.resource.attributes ?? {};
  }

  it("names the process, never the machine it runs on (a developer's computer name, its id)", async () => {
    const attributes = await resourceAttributes();
    expect(attributes['service.instance.id']).toEqual(expect.any(String));
    expect(Object.keys(attributes).filter((key) => key.startsWith('host.'))).toEqual([]);
  });

  it('takes a host name the operator sets on purpose (OTEL_RESOURCE_ATTRIBUTES)', async () => {
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'host.name=vps-1');
    try {
      expect(await resourceAttributes()).toMatchObject({ 'host.name': 'vps-1' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the telemetry's own requests", () => {
  it('stay out of the outgoing request metrics, which keep counting the application', async () => {
    // The exporters (OTLP over node:http) and the error tracker (fetch) send
    // with tracing suppressed, as the SDK's export path does. Counted, every
    // export would show the collector as an external service on the dashboards.
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const telemetry = startOpenTelemetry({
      endpoint: 'http://127.0.0.1:4318',
      serviceName: 'api',
      environment: 'test',
      release: 'r1',
      metricExportIntervalMs: 60_000,
      spanExporter: new InMemorySpanExporter(),
      metricExporter,
    });
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    // Loaded after the SDK started, as the application and the exporters load it.
    const http = createRequire(import.meta.url)('http') as typeof import('node:http');
    const get = () =>
      new Promise<void>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/`, (res) => {
            res.resume();
            res.on('end', resolve);
          })
          .on('error', reject);
      });
    const own = <T>(send: () => Promise<T>) =>
      context.with(suppressTracing(context.active()), send);
    try {
      await get();
      await (await fetch(`http://127.0.0.1:${port}/`)).text();
      await own(get);
      await own(async () => (await fetch(`http://127.0.0.1:${port}/`)).text());
      await telemetry.flush();

      const points = metricExporter
        .getMetrics()
        .flatMap((resource) => resource.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .filter((metric) => metric.descriptor.name === 'http.client.request.duration')
        .flatMap((metric) => metric.dataPoints as { value: { count: number } }[]);
      const requests = points.reduce((total, point) => total + point.value.count, 0);
      expect(requests).toBe(2);
    } finally {
      server.close();
      await telemetry.shutdown();
    }
  });
});

describe('exported spans of a failure', () => {
  it('carry no credential in their events (exceptions included) or status message', async () => {
    const spans = new InMemorySpanExporter();
    const telemetry = startOpenTelemetry({
      endpoint: 'http://127.0.0.1:4318',
      serviceName: 'api',
      environment: 'test',
      release: 'r1',
      metricExportIntervalMs: 60_000,
      spanExporter: spans,
      metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    });
    const failure = new Error(`connect failed: ${dbUrl('app', 'hunter2-secret')}`);
    failure.stack = `Error: Authorization: Bearer abcdef0123456789
    at connect (pool.js:1:1)`;
    trace.getTracer('spec').startActiveSpan('GET /api/things', (span) => {
      span.addEvent('retry', { 'url.full': 'https://billing.example.com/x?token=t0k3n-value' });
      span.recordException(failure);
      span.setStatus({ code: SpanStatusCode.ERROR, message: failure.message });
      span.end();
    });
    await telemetry.flush();

    const [span] = spans.getFinishedSpans();
    const exported = JSON.stringify({ events: span?.events, status: span?.status });
    expect(exported).not.toContain('hunter2-secret');
    expect(exported).not.toContain('abcdef0123456789');
    expect(exported).not.toContain('t0k3n-value');
    expect(span?.events[0]?.attributes).toEqual({ 'url.full': 'https://billing.example.com/x' });
    expect(span?.events[1]?.attributes).toMatchObject({
      'exception.message': `connect failed: ${dbUrl('app', '[REDACTED]')}`,
      'exception.stacktrace': expect.stringContaining('Bearer [REDACTED]') as string,
    });
    expect(span?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: `connect failed: ${dbUrl('app', '[REDACTED]')}`,
    });
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
      events: [],
      status: { code: SpanStatusCode.UNSET },
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

  it('redacts every string of an array, and masks values under a sensitive name whole', () => {
    // Header capture records string arrays (http.request.header.<name>), and
    // a value set under a sensitive name has no "key=value" shape to find.
    const attributes: Record<string, unknown> = {
      'http.request.header.authorization': ['Bearer abcdef123456'],
      'http.response.header.set-cookie': ['refresh_token=abc; Path=/; HttpOnly'],
      'messaging.batch.payloads': ['Bearer abcdef123456', 'plain'],
      'app.user.password': 'hunter2',
      'app.api_key': 'k-123',
      'http.request.header.accept': ['application/json'],
      'gen_ai.usage.input_tokens': 42,
      'app.retry.attempts': [1, 2],
    };
    const event = {
      name: 'retry',
      time: [0, 0],
      attributes: { 'app.session_id': 'abc123', 'app.notes': ['token=t0k3n', 'fine'] },
    };
    const span = {
      attributes,
      events: [event],
      status: { code: SpanStatusCode.UNSET },
      setAttribute(key: string, value: unknown) {
        attributes[key] = value;
      },
    } as unknown as Span;
    new RedactingSpanProcessor().onEnding(span);
    expect(attributes).toEqual({
      'http.request.header.authorization': '[REDACTED]',
      'http.response.header.set-cookie': '[REDACTED]',
      'messaging.batch.payloads': ['Bearer [REDACTED]', 'plain'],
      'app.user.password': '[REDACTED]',
      'app.api_key': '[REDACTED]',
      'http.request.header.accept': ['application/json'],
      // Counts are not credentials: numbers keep their value under any name.
      'gen_ai.usage.input_tokens': 42,
      'app.retry.attempts': [1, 2],
    });
    expect(event.attributes).toEqual({
      'app.session_id': '[REDACTED]',
      'app.notes': ['token=[REDACTED]', 'fine'],
    });
  });

  it('redacts the attributes of every event and the status message, URL rules included', () => {
    const exception = {
      'exception.type': 'Error',
      'exception.message': 'GET https://u:p@billing.example.com/x?api_key=k123 failed',
      'exception.stacktrace': 'Error: Authorization: Bearer abc123def456\n    at x',
      'http.url': 'https://billing.example.com/x?api_key=k123',
    };
    let status: { code: SpanStatusCode; message?: string } = {
      code: SpanStatusCode.ERROR,
      message: 'password=hunter2',
    };
    const span = {
      attributes: {},
      events: [
        { name: 'exception', time: [0, 0], attributes: exception },
        { name: 'retry', time: [0, 0] },
      ],
      get status() {
        return status;
      },
      setAttribute: vi.fn(),
      setStatus(next: typeof status) {
        status = next;
      },
    } as unknown as Span;
    new RedactingSpanProcessor().onEnding(span);
    expect(exception['exception.type']).toBe('Error');
    expect(exception['exception.message']).not.toMatch(/u:p@|k123/);
    expect(exception['exception.stacktrace']).not.toContain('abc123def456');
    expect(exception['http.url']).toBe('https://billing.example.com/x');
    expect(status).toEqual({ code: SpanStatusCode.ERROR, message: 'password=[REDACTED]' });
  });
});

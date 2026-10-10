import type { IncomingMessage } from 'node:http';
import { metrics, type ObservableResult } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import {
  defaultResource,
  detectResources,
  envDetector,
  hostDetector,
  resourceFromAttributes,
  serviceInstanceIdDetector,
} from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { OpenTelemetry as RedisTelemetry } from '@redis/client';
import { register as registerEsmHooks } from 'import-in-the-middle/register-hooks.mjs';
import { redactText, redactUrl } from './redact.js';
import type { Telemetry } from './telemetry.js';

// The OpenTelemetry SDK, imported only when telemetry is on (telemetry.ts).
// Traces and metrics go over OTLP/HTTP (JSON) to OTEL_EXPORTER_OTLP_ENDPOINT
// + /v1/traces and /v1/metrics: a collector or a provider
// (docs/observability.md#opentelemetry). Credentials (OTEL_EXPORTER_OTLP_HEADERS)
// are read by the exporters themselves and never pass through this code.
//
// Instrumented, and nothing else: incoming HTTP (server spans and the request
// duration histogram), Express routing (the route of each request, where the
// time went), PostgreSQL (query spans without values, connection pool
// metrics), outgoing fetch (external services), Redis (node-redis's own
// metrics), the Node.js runtime (event loop, heap, GC) and process CPU and
// memory. NestJS handler spans are not included: the official instrumentation
// does not support Nest 12 yet.

export interface OpenTelemetryOptions {
  /** OTLP/HTTP base URL; the signal paths are appended. */
  endpoint: string;
  serviceName: string;
  environment: string;
  release: string;
  metricExportIntervalMs: number;
  /** Tests pass in-memory exporters; production uses OTLP. */
  spanExporter?: SpanExporter;
  metricExporter?: PushMetricExporter;
}

/** The OTLP/HTTP URL of a signal: <endpoint>/v1/<signal>, keeping any base path. */
export function signalUrl(endpoint: string, signal: 'traces' | 'metrics'): string {
  return new URL(`v1/${signal}`, endpoint.endsWith('/') ? endpoint : `${endpoint}/`).toString();
}

/** Health probes run every few seconds: never traced, never in the request metrics. */
export function isHealthProbe(request: IncomingMessage): boolean {
  return request.url?.toLowerCase().startsWith('/api/health/') ?? false;
}

export function startOpenTelemetry(options: OpenTelemetryOptions): Telemetry {
  const resource = defaultResource()
    .merge(detectResources({ detectors: [envDetector, hostDetector, serviceInstanceIdDetector] }))
    .merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName,
        [ATTR_SERVICE_VERSION]: options.release,
        'deployment.environment.name': options.environment,
      }),
    );

  const tracerProvider = new NodeTracerProvider({
    resource,
    // Redaction runs first, while the span can still be changed.
    spanProcessors: [
      new RedactingSpanProcessor(),
      new BatchSpanProcessor(
        options.spanExporter ??
          new OTLPTraceExporter({ url: signalUrl(options.endpoint, 'traces') }),
      ),
    ],
  });
  // Global tracer, AsyncLocalStorage context, W3C trace context propagation.
  tracerProvider.register();

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter:
          options.metricExporter ??
          new OTLPMetricExporter({ url: signalUrl(options.endpoint, 'metrics') }),
        exportIntervalMillis: options.metricExportIntervalMs,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const instrumentations = [
    new HttpInstrumentation({ ignoreIncomingRequestHook: isHealthProbe }),
    // Routers and handlers; the dozen middleware layers of every request
    // (helmet, cookies, body parsing) would only add noise.
    new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE] }),
    // Statements are recorded with their placeholders ($1), never values.
    new PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false }),
    new UndiciInstrumentation(),
    new RuntimeNodeInstrumentation(),
  ];
  interceptEsmImports(
    instrumentations.flatMap((instrumentation) =>
      instrumentation.getModuleDefinitions().map((definition) => definition.name),
    ),
  );
  const unregister = registerInstrumentations({ instrumentations });
  startRedisMetrics();
  observeProcess();

  return {
    enabled: true,
    async flush() {
      await Promise.allSettled([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
    },
    async shutdown() {
      unregister();
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
}

// The instrumentations patch modules as they load. `require()` is hooked by
// default, but Nest 12 loads its HTTP platform (and with it Express) with
// `import()`, which only an ESM loader hook sees. This one runs in-thread
// (module.registerHooks, available on every Node.js version package.json
// "engines" allows) and intercepts exactly the instrumented modules, nothing
// else. Registered once per process: hooks cannot be removed.
const ESM_HOOKS = Symbol.for('app.telemetry.esm-hooks');
function interceptEsmImports(modules: string[]): void {
  const registry = globalThis as typeof globalThis & { [ESM_HOOKS]?: true };
  if (registry[ESM_HOOKS]) return;
  registry[ESM_HOOKS] = true;
  registerEsmHooks({ include: [...new Set(modules)] });
}

// node-redis records its own metrics (command duration, errors, connections)
// once initialized, before any client exists. It can be initialized once per
// process: a second start (tests) keeps the first registration.
function startRedisMetrics(): void {
  try {
    RedisTelemetry.init({
      metrics: {
        enabled: true,
        enabledMetricGroups: ['command', 'connection-basic', 'resiliency'],
      },
    });
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('already initialized'))) throw error;
  }
}

/** CPU time and resident memory of this process (OpenTelemetry process semantic conventions). */
function observeProcess(): void {
  const meter = metrics.getMeter('app.process');
  meter
    .createObservableCounter('process.cpu.time', { description: 'CPU time used', unit: 's' })
    .addCallback((result: ObservableResult) => {
      const usage = process.cpuUsage();
      result.observe(usage.user / 1e6, { 'cpu.mode': 'user' });
      result.observe(usage.system / 1e6, { 'cpu.mode': 'system' });
    });
  meter
    .createObservableUpDownCounter('process.memory.usage', {
      description: 'Resident set size',
      unit: 'By',
    })
    .addCallback((result: ObservableResult) => {
      result.observe(process.memoryUsage.rss());
    });
}

const URL_ATTRIBUTES = new Set(['url.full', 'http.url', 'http.target', 'url.query']);

/**
 * The last word on what a span may carry: query strings and URL credentials
 * are removed (tokens and personal data travel there), and every string
 * attribute is redacted like a log line. Runs in onEnding, the last moment a
 * span can still be changed, so it covers every instrumentation.
 */
export class RedactingSpanProcessor implements SpanProcessor {
  onStart(): void {
    // Attributes are set during the span's life; redaction waits for its end.
  }

  onEnding(span: Span): void {
    for (const [key, value] of Object.entries(span.attributes)) {
      if (typeof value !== 'string') continue;
      if (key === 'url.query') {
        span.setAttribute(key, '[REDACTED]');
      } else if (URL_ATTRIBUTES.has(key)) {
        span.setAttribute(
          key,
          key === 'http.target' ? (value.split('?', 1)[0] ?? '') : redactUrl(value),
        );
      } else {
        const redacted = redactText(value);
        if (redacted !== value) span.setAttribute(key, redacted);
      }
    }
  }

  onEnd(): void {
    // Exporting is the next processor's job.
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

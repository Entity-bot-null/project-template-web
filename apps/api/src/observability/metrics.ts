import { type Attributes, type Counter, type Histogram, metrics } from '@opentelemetry/api';

// The application's own metrics, next to the ones the instrumentations record
// (HTTP server and client, database, runtime: docs/observability.md#metrics).
// Written against the OpenTelemetry API, which is a no-op until the SDK is
// started: with telemetry off (the default) recording costs a function call.
//
// Instruments are created on first use, not at import: the SDK registers its
// meter provider at boot, and an instrument created before that would stay a
// no-op forever.

const meter = () => metrics.getMeter('app');

function lazy<T>(create: () => T): () => T {
  let instrument: T | undefined;
  return () => (instrument ??= create());
}

/** Seconds, the unit of every duration histogram (OpenTelemetry semantic conventions). */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

const serverErrors = lazy<Counter>(() =>
  meter().createCounter('app.server.errors', {
    description: 'Responses with a 5xx status, by where the failure came from',
  }),
);

const dependencyDuration = lazy<Histogram>(() =>
  meter().createHistogram('app.dependency.duration', {
    description: 'Calls to external services through the shared HTTP client, retries included',
    unit: 's',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  }),
);

const cacheOperations = lazy<Counter>(() =>
  meter().createCounter('app.cache.operations', {
    description: 'Cache reads by result (hit, miss, error)',
  }),
);

const degradations = lazy<Counter>(() =>
  meter().createCounter('app.degraded.operations', {
    description: 'Operations served by a fallback because an optional dependency was unavailable',
  }),
);

const slowQueries = lazy<Counter>(() =>
  meter().createCounter('app.db.slow_queries', {
    description: 'Database queries slower than DB_SLOW_QUERY_MS',
  }),
);

// Web Vitals the web app reports (telemetry/web-vitals.ts). The buckets hold
// every rating threshold of web.dev, so the share of good page loads and the
// p75 compared with a threshold are exact.
const webVitalDuration = lazy<Histogram>(() =>
  meter().createHistogram('app.web_vitals.duration', {
    description: 'Web Vitals of page loads measured in the browser: LCP, INP, FCP, TTFB',
    unit: 's',
    advice: {
      explicitBucketBoundaries: [0.05, 0.1, 0.2, 0.5, 0.8, 1, 1.8, 2.5, 3, 4, 6, 10],
    },
  }),
);

const webVitalLayoutShift = lazy<Histogram>(() =>
  meter().createHistogram('app.web_vitals.cls', {
    description: 'Cumulative layout shift of page loads measured in the browser',
    unit: '1',
    advice: { explicitBucketBoundaries: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1] },
  }),
);

/** Where a failure came from: the first question of every incident. */
export type ErrorOrigin = 'application' | 'database' | 'dependency' | 'unavailable';

export function recordServerError(origin: ErrorOrigin, route: string | undefined): void {
  const attributes: Attributes = { 'error.origin': origin };
  if (route !== undefined) attributes['http.route'] = route;
  serverErrors().add(1, attributes);
}

export function recordDependencyCall(
  dependency: string,
  outcome: 'success' | 'http_error' | 'timeout' | 'network_error',
  seconds: number,
  statusCode?: number,
): void {
  const attributes: Attributes = { 'dependency.name': dependency, outcome };
  if (statusCode !== undefined) attributes['http.response.status_code'] = statusCode;
  dependencyDuration().record(seconds, attributes);
}

export function recordCacheRead(namespace: string, result: 'hit' | 'miss' | 'error'): void {
  cacheOperations().add(1, { 'cache.namespace': namespace, 'cache.result': result });
}

export function recordDegradation(feature: string, dependency: string): void {
  degradations().add(1, { feature, 'dependency.name': dependency });
}

export function recordSlowQuery(): void {
  slowQueries().add(1);
}

export type WebVitalRating = 'good' | 'needs-improvement' | 'poor';

/**
 * One Web Vital of a page load: seconds for the timings, the score for CLS.
 * Every attribute comes from a closed list (telemetry/web-vitals.schemas.ts).
 */
export function recordWebVital(
  name: 'CLS' | 'FCP' | 'INP' | 'LCP' | 'TTFB',
  value: number,
  page: { rating: WebVitalRating; navigationType: string; route: string },
): void {
  const attributes: Attributes = {
    'web_vital.rating': page.rating,
    'web_vital.navigation_type': page.navigationType,
    'page.route': page.route,
  };
  if (name === 'CLS') {
    webVitalLayoutShift().record(value, attributes);
  } else {
    webVitalDuration().record(value, { ...attributes, 'web_vital.name': name });
  }
}

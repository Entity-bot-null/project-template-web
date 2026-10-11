import { matchRoutes, type RouteObject } from 'react-router';
import { type MetricType, onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';
import type { paths } from '../api/schema';
import { routes } from '../router';

// The lazy half of Web Vitals (webVitals.ts loads it): measures with the
// web-vitals library, queues the values, and sends them in one request when
// the page is hidden, the moment the library reports CLS, INP and LCP and the
// last one a page is sure to get. Each metric of a page load is sent once.
//
// What leaves the browser: the metric, its value, the navigation type, and the
// route pattern of the page ("/admin/users"), never its URL, query string or
// anything about the user (docs/security.md#web-vitals).

type Report =
  paths['/api/telemetry/web-vitals']['post']['requestBody']['content']['application/json'];
/** The route patterns the API accepts (WEB_VITALS_ROUTES in the API). */
export type PageRoute = Report['route'];
type ReportedMetric = Report['metrics'][number];

export const WEB_VITALS_URL = '/api/telemetry/web-vitals';
/** The API refuses bigger batches (MAX_WEB_VITALS_PER_BATCH); a full queue is sent at once. */
export const MAX_BATCH = 10;

/**
 * The route pattern a path matches ("/admin/users", "/" for the index, "/*"
 * for the not-found page): the page label, so ids and tokens in a path never
 * leave the browser.
 */
export function routePattern(pathname: string, routeList: RouteObject[] = routes): string {
  const segments = (matchRoutes(routeList, pathname) ?? [])
    .map(({ route }) => route.path?.replace(/^\/+|\/+$/g, '') ?? '')
    .filter((segment) => segment !== '');
  return `/${segments.join('/')}`;
}

/** Sends a batch: sendBeacon, which survives the page closing; else fetch with keepalive. */
export function send(body: string): void {
  if (beacon(body)) return;
  // sendBeacon refused (over its quota), threw or missing. A lost report is
  // not an error to report: the page may be going away.
  fetch(WEB_VITALS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => undefined);
}

function beacon(body: string): boolean {
  if (typeof navigator.sendBeacon !== 'function') return false;
  try {
    return navigator.sendBeacon(WEB_VITALS_URL, new Blob([body], { type: 'application/json' }));
  } catch {
    // Some browsers refused a JSON Blob in a beacon (a SecurityError): an
    // exception here would escape the page-hide listener on every hide.
    return false;
  }
}

export interface Reporter {
  add: (metric: MetricType) => void;
  /** Sends what is queued, if anything. */
  flush: () => void;
}

/**
 * Queues the metrics of one page load and sends each of them once. The
 * library reports CLS and INP again whenever the page is hidden after they
 * grew (a tab hidden and shown again), with the same id: a metric already
 * sent is not sent again, so one page load is one sample of each metric, as
 * the histograms and the "page loads" counts assume. Its value is the one at
 * the first hide; until then a newer report replaces the queued one.
 */
export function createReporter(route: PageRoute, transport: (body: string) => void): Reporter {
  const queue = new Map<string, ReportedMetric>();
  const sent = new Set<string>();
  const flush = () => {
    if (queue.size === 0) return;
    const report: Report = { route, metrics: [...queue.values()] };
    for (const id of queue.keys()) sent.add(id);
    queue.clear();
    transport(JSON.stringify(report));
  };
  return {
    add: (metric) => {
      if (sent.has(metric.id)) return;
      const { value, navigationType } = metric;
      queue.set(
        metric.id,
        metric.name === 'CLS'
          ? { name: 'CLS', value, navigationType }
          : { name: metric.name, value, navigationType },
      );
      if (queue.size >= MAX_BATCH) flush();
    },
    flush,
  };
}

/** Measures this page load and reports it, labelled with the route pattern of `pathname`. */
export function reportWebVitals(pathname: string, transport: (body: string) => void = send): void {
  // Every route of the app is one the API accepts (webVitalsReporter.spec.ts).
  const reporter = createReporter(routePattern(pathname) as PageRoute, transport);
  for (const observe of [onCLS, onFCP, onINP, onLCP, onTTFB]) observe(reporter.add);
  // A listener on the document runs after the library's own (window, capture
  // phase), which report CLS, INP and LCP on this same event: the batch then
  // holds them. pagehide covers browsers that skip visibilitychange on unload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') reporter.flush();
  });
  window.addEventListener('pagehide', reporter.flush);
}

import { recordWebVital, type WebVitalRating } from '../observability/metrics.js';
import type { WebVital, WebVitalsReport } from './web-vitals.schemas.js';

// The thresholds of web.dev for each metric: up to the first is "good", up to
// the second "needs improvement", above it "poor" (milliseconds, CLS
// unitless). The rating is computed here from the value, never taken from the
// client, so every rating label means the same thing.
const THRESHOLDS: Readonly<Record<WebVital['name'], readonly [number, number]>> = {
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  INP: [200, 500],
  LCP: [2500, 4000],
  TTFB: [800, 1800],
};

export function rateWebVital(name: WebVital['name'], value: number): WebVitalRating {
  const [good, poor] = THRESHOLDS[name];
  if (value <= good) return 'good';
  return value <= poor ? 'needs-improvement' : 'poor';
}

/**
 * Records every metric of a validated report. With telemetry off the
 * instruments are no-ops: the route still validates and answers, at the cost
 * of a few function calls.
 */
export function recordWebVitals(report: WebVitalsReport): void {
  for (const metric of report.metrics) {
    recordWebVital(metric.name, metric.name === 'CLS' ? metric.value : metric.value / 1000, {
      rating: rateWebVital(metric.name, metric.value),
      navigationType: metric.navigationType,
      route: report.route,
    });
  }
}

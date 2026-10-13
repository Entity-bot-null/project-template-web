import { z } from 'zod';

// What the web app reports about its page loads (POST /api/telemetry/web-vitals,
// docs/observability.md#web-vitals). Every value ends up as a metric attribute
// or a histogram sample, so every field is bounded: a public route must not
// let a client create series at will or skew the sums.

/**
 * The route patterns of the web app (apps/web/src/router.tsx), the only page
 * labels accepted: the pattern, never the URL, so no id, token or query string
 * reaches the metrics. apps/web/src/monitoring/webVitalsReporter.spec.ts fails
 * when a route of the app is missing here: add it, then run `pnpm contract`.
 */
export const WEB_VITALS_ROUTES = [
  '/',
  '/sign-in',
  '/forgot-password',
  '/reset-password',
  '/sign-up',
  '/confirm-sign-up',
  '/account',
  '/admin/users',
  '/*',
] as const;

/** Navigation types as the web-vitals library names them. */
export const NAVIGATION_TYPES = [
  'navigate',
  'reload',
  'back-forward',
  'back-forward-cache',
  'prerender',
  'restore',
  'soft-navigation',
] as const;

/** The timing metrics, in milliseconds as the browser measures them. */
export const DURATION_METRICS = ['FCP', 'INP', 'LCP', 'TTFB'] as const;

/** One batch holds at most this many metrics (a page load reports five). */
export const MAX_WEB_VITALS_PER_BATCH = 10;

// Beyond any real page load: two minutes, and a layout that shifted fifty
// whole viewports. A value outside refuses the batch.
const MAX_DURATION_MS = 120_000;
const MAX_LAYOUT_SHIFT = 50;

const navigationType = z.enum(NAVIGATION_TYPES);

export const WebVitalSchema = z.discriminatedUnion('name', [
  z.strictObject({
    name: z.enum(DURATION_METRICS),
    /** Milliseconds. */
    value: z.number().min(0).max(MAX_DURATION_MS),
    navigationType,
  }),
  z.strictObject({
    name: z.literal('CLS'),
    /** Cumulative layout shift score, unitless. */
    value: z.number().min(0).max(MAX_LAYOUT_SHIFT),
    navigationType,
  }),
]);
export type WebVital = z.infer<typeof WebVitalSchema>;

export const WebVitalsReportSchema = z.strictObject({
  /** The route pattern of the page as loaded, e.g. "/admin/users". */
  route: z.enum(WEB_VITALS_ROUTES),
  metrics: z.array(WebVitalSchema).min(1).max(MAX_WEB_VITALS_PER_BATCH),
});
export type WebVitalsReport = z.infer<typeof WebVitalsReportSchema>;

import { afterAll, describe, expect, it } from 'vitest';
import { recordMetrics } from '../../test/metrics.js';
import { rateWebVital, recordWebVitals } from './web-vitals.js';
import { MAX_WEB_VITALS_PER_BATCH, WebVitalsReportSchema } from './web-vitals.schemas.js';

const recorded = recordMetrics();

afterAll(async () => {
  await recorded.stop();
});

const lcp = { name: 'LCP', value: 1200, navigationType: 'navigate' } as const;
const valid = { route: '/admin/users', metrics: [lcp] };

describe('WebVitalsReportSchema', () => {
  it('accepts a report of the web app', () => {
    const report = {
      route: '/',
      metrics: [
        { name: 'TTFB', value: 80.5, navigationType: 'navigate' },
        { name: 'FCP', value: 640, navigationType: 'reload' },
        { name: 'LCP', value: 1200, navigationType: 'back-forward' },
        { name: 'INP', value: 0, navigationType: 'back-forward-cache' },
        { name: 'CLS', value: 0.02, navigationType: 'prerender' },
      ],
    };
    expect(WebVitalsReportSchema.parse(report)).toEqual(report);
  });

  it.each([
    ['a URL instead of the route pattern', { ...valid, route: '/admin/users?page=2' }],
    ['a page the web app does not have', { ...valid, route: '/users/3f1c' }],
    ['a full URL', { ...valid, route: 'https://app.example.com/' }],
    ['no metric', { ...valid, metrics: [] }],
    [
      'more metrics than a batch holds',
      { ...valid, metrics: Array.from({ length: MAX_WEB_VITALS_PER_BATCH + 1 }, () => lcp) },
    ],
    ['an unknown metric', { ...valid, metrics: [{ ...lcp, name: 'FID' }] }],
    ['a negative value', { ...valid, metrics: [{ ...lcp, value: -1 }] }],
    ['a duration beyond two minutes', { ...valid, metrics: [{ ...lcp, value: 120_001 }] }],
    [
      'a layout shift beyond any page',
      { ...valid, metrics: [{ name: 'CLS', value: 51, navigationType: 'navigate' }] },
    ],
    ['a value that is not a number', { ...valid, metrics: [{ ...lcp, value: '1200' }] }],
    ['an unknown navigation type', { ...valid, metrics: [{ ...lcp, navigationType: 'x' }] }],
    // Strict: nothing else rides along (the page URL, an id, a user agent).
    ['an extra field in a metric', { ...valid, metrics: [{ ...lcp, url: '/admin/users?x=1' }] }],
    ['an extra field in the report', { ...valid, userId: 'u1' }],
  ])('refuses %s', (_case, report) => {
    expect(WebVitalsReportSchema.safeParse(report).success).toBe(false);
  });
});

describe('rateWebVital', () => {
  it.each([
    ['LCP', 2500, 'good'],
    ['LCP', 2501, 'needs-improvement'],
    ['LCP', 4000, 'needs-improvement'],
    ['LCP', 4001, 'poor'],
    ['INP', 200, 'good'],
    ['INP', 500, 'needs-improvement'],
    ['INP', 501, 'poor'],
    ['CLS', 0.1, 'good'],
    ['CLS', 0.25, 'needs-improvement'],
    ['CLS', 0.26, 'poor'],
    ['FCP', 1800, 'good'],
    ['FCP', 3001, 'poor'],
    ['TTFB', 800, 'good'],
    ['TTFB', 1800, 'needs-improvement'],
  ] as const)('rates %s %d as %s, with the thresholds of web.dev', (name, value, rating) => {
    expect(rateWebVital(name, value)).toBe(rating);
  });
});

describe('recordWebVitals', () => {
  it('records timings in seconds and CLS apart, labelled by metric, rating, route and navigation', async () => {
    recordWebVitals({
      route: '/sign-in',
      metrics: [
        { name: 'LCP', value: 3200, navigationType: 'navigate' },
        { name: 'INP', value: 120, navigationType: 'navigate' },
        { name: 'CLS', value: 0.3, navigationType: 'reload' },
      ],
    });

    const durations = await recorded.histogram('app.web_vitals.duration');
    expect(
      durations.map(({ attributes, value }) => ({
        attributes,
        sum: value.sum,
        count: value.count,
      })),
    ).toEqual([
      {
        attributes: {
          'web_vital.name': 'LCP',
          'web_vital.rating': 'needs-improvement',
          'web_vital.navigation_type': 'navigate',
          'page.route': '/sign-in',
        },
        sum: 3.2,
        count: 1,
      },
      {
        attributes: {
          'web_vital.name': 'INP',
          'web_vital.rating': 'good',
          'web_vital.navigation_type': 'navigate',
          'page.route': '/sign-in',
        },
        sum: 0.12,
        count: 1,
      },
    ]);
    // The rating thresholds are bucket boundaries: p75 against them is exact.
    expect(durations[0]?.value.buckets.boundaries).toEqual(
      expect.arrayContaining([0.2, 0.5, 0.8, 1.8, 2.5, 3, 4]),
    );

    const shifts = await recorded.histogram('app.web_vitals.cls');
    expect(shifts.map(({ attributes, value }) => ({ attributes, sum: value.sum }))).toEqual([
      {
        attributes: {
          'web_vital.rating': 'poor',
          'web_vital.navigation_type': 'reload',
          'page.route': '/sign-in',
        },
        sum: 0.3,
      },
    ]);
    expect(shifts[0]?.value.buckets.boundaries).toEqual(expect.arrayContaining([0.1, 0.25]));
  });
});

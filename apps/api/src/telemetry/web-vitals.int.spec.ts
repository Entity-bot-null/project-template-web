import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../test/app.js';
import { recordMetrics } from '../../test/metrics.js';
import { WEB_VITALS_RATE_LIMIT } from './web-vitals.controller.js';

// POST /api/telemetry/web-vitals through the production pipeline: public, the
// global Fetch Metadata guard, JSON only, the route's own rate limit, and the
// metrics it records. Registered before the app records anything.
const recorded = recordMetrics();

/** How many LCP, INP, FCP and TTFB values were recorded so far. */
const durationCount = async () =>
  (await recorded.histogram('app.web_vitals.duration')).reduce(
    (sum, point) => sum + point.value.count,
    0,
  );

const report = {
  route: '/admin/users',
  metrics: [
    { name: 'LCP', value: 2100, navigationType: 'navigate' },
    { name: 'CLS', value: 0.04, navigationType: 'navigate' },
  ],
};

describe('Web Vitals (integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
    await recorded.stop();
  });

  // What navigator.sendBeacon sends from the app's own page.
  const beacon = (app: TestApp, body: unknown) =>
    request(app.server)
      .post('/api/telemetry/web-vitals')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));

  it('records a report from the app without a session and answers 204, no body', async () => {
    const res = await beacon(t, report).expect(204);
    expect(res.text).toBe('');

    const durations = await recorded.histogram('app.web_vitals.duration');
    expect(durations.map(({ attributes, value }) => ({ attributes, sum: value.sum }))).toEqual([
      {
        attributes: {
          'web_vital.name': 'LCP',
          'web_vital.rating': 'good',
          'web_vital.navigation_type': 'navigate',
          'page.route': '/admin/users',
        },
        sum: 2.1,
      },
    ]);
    const shifts = await recorded.histogram('app.web_vitals.cls');
    expect(shifts.map(({ value }) => value.count)).toEqual([1]);
  });

  it('refuses a page URL instead of its route pattern, and records nothing', async () => {
    const before = await durationCount();
    const res = await beacon(t, { ...report, route: '/admin/users?page=2' }).expect(400);
    expect(res.body).toEqual({ data: null, message: expect.stringContaining('route') as string });
    expect(await durationCount()).toBe(before);
  });

  it('refuses a body that is not JSON (what a cross-site form can send)', async () => {
    await request(t.server)
      .post('/api/telemetry/web-vitals')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(report))
      .expect(415);
  });

  it('refuses a report another site made the browser send', async () => {
    const before = await durationCount();
    const res = await request(t.server)
      .post('/api/telemetry/web-vitals')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(report))
      .expect(403);
    expect(res.body).toEqual({ data: null, message: 'Cross-origin request refused' });
    expect(await durationCount()).toBe(before);
  });

  it("applies the route's own rate limit on top of the global one", async () => {
    // A fresh app: its counters start at zero.
    const limited = await createTestApp();
    try {
      const first = await beacon(limited, report).expect(204);
      expect(first.headers['x-ratelimit-limit-route']).toBe(String(WEB_VITALS_RATE_LIMIT.limit));
      for (let sent = 1; sent < WEB_VITALS_RATE_LIMIT.limit; sent += 1) {
        await beacon(limited, report).expect(204);
      }
      const blocked = await beacon(limited, report).expect(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await limited.app.close();
    }
  });
});

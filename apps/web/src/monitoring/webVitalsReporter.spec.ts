import type { RouteObject } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetricType } from 'web-vitals';
import contract from '../../../../openapi/openapi.json?raw';
import { routes } from '../router';
import {
  createReporter,
  MAX_BATCH,
  reportWebVitals,
  routePattern,
  send,
  WEB_VITALS_URL,
} from './webVitalsReporter';

// The library measures real page loads only; here its callbacks are captured
// and called with made-up metrics.
const observers = vi.hoisted(() => new Map<string, (metric: unknown) => void>());
vi.mock('web-vitals', () => {
  const observe = (name: string) => (callback: (metric: unknown) => void) => {
    observers.set(name, callback);
  };
  return {
    onCLS: observe('CLS'),
    onFCP: observe('FCP'),
    onINP: observe('INP'),
    onLCP: observe('LCP'),
    onTTFB: observe('TTFB'),
  };
});

/** A metric as web-vitals reports it, with the fields that must not leave the browser. */
function metric(name: MetricType['name'], value: number): MetricType {
  return {
    name,
    value,
    rating: 'good',
    delta: value,
    id: 'v5-1700000000000-123',
    entries: [],
    navigationType: 'navigate',
    navigationId: 1,
    navigationURL: 'https://app.example.com/admin/users?token=secret',
  };
}

afterEach(() => {
  observers.clear();
});

/** Every page pattern of a route tree: what routePattern can return for it. */
function patterns(list: RouteObject[], prefix = ''): string[] {
  return list.flatMap((route) => {
    const path = route.path === undefined ? prefix : `${prefix}/${route.path}`;
    if (route.children !== undefined) return patterns(route.children, path);
    return [path === '' ? '/' : path];
  });
}

describe('routePattern', () => {
  it('labels a page with its route pattern, never its path', () => {
    expect(routePattern('/')).toBe('/');
    expect(routePattern('/sign-in')).toBe('/sign-in');
    expect(routePattern('/admin/users')).toBe('/admin/users');
    expect(routePattern('/admin/users/')).toBe('/admin/users');
    expect(routePattern('/no/such/page')).toBe('/*');
  });

  it('keeps ids and other path values out of the label', () => {
    const withParams: RouteObject[] = [
      { path: 'users/:userId', children: [{ path: 'files/*' }] },
      { path: '*' },
    ];
    expect(routePattern('/users/3f1c9a2e/files/report.pdf', withParams)).toBe(
      '/users/:userId/files/*',
    );
    expect(routePattern('/someone@example.com', withParams)).toBe('/*');
  });

  it("covers exactly the pages the API accepts (its WEB_VITALS_ROUTES): add a new route's pattern there", () => {
    const parsed = JSON.parse(contract) as {
      paths: Record<
        string,
        { post: { requestBody: { content: Record<string, { schema: unknown }> } } }
      >;
    };
    const schema = parsed.paths['/api/telemetry/web-vitals']?.post.requestBody.content[
      'application/json'
    ]?.schema as { properties: { route: { enum: string[] } } };
    const appPages = patterns(routes);
    expect([...appPages].sort()).toEqual([...schema.properties.route.enum].sort());
    for (const page of appPages) expect(routePattern(page)).toBe(page);
  });
});

describe('createReporter', () => {
  it('sends the queued metrics in one batch: name, value and navigation type, nothing else', () => {
    const transport = vi.fn();
    const reporter = createReporter('/admin/users', transport);
    reporter.add(metric('TTFB', 81.2));
    reporter.add(metric('LCP', 1830));
    reporter.add(metric('CLS', 0.07));
    expect(transport).not.toHaveBeenCalled();

    reporter.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.mock.calls[0]?.[0] as string)).toEqual({
      route: '/admin/users',
      metrics: [
        { name: 'TTFB', value: 81.2, navigationType: 'navigate' },
        { name: 'LCP', value: 1830, navigationType: 'navigate' },
        { name: 'CLS', value: 0.07, navigationType: 'navigate' },
      ],
    });

    // Nothing queued, nothing sent.
    reporter.flush();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('sends a full batch at once, within what the API accepts', () => {
    const transport = vi.fn();
    const reporter = createReporter('/', transport);
    for (let index = 0; index < MAX_BATCH; index += 1) reporter.add(metric('INP', 40 + index));
    expect(transport).toHaveBeenCalledTimes(1);
    const body = JSON.parse(transport.mock.calls[0]?.[0] as string) as { metrics: unknown[] };
    expect(body.metrics).toHaveLength(MAX_BATCH);
  });
});

describe('send', () => {
  it('uses sendBeacon with a JSON body', async () => {
    const sendBeacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    vi.stubGlobal('navigator', { sendBeacon });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    send('{"route":"/"}');

    expect(sendBeacon).toHaveBeenCalledWith(WEB_VITALS_URL, expect.any(Blob));
    const blob = sendBeacon.mock.calls[0]?.[1] as Blob;
    expect(blob.type).toBe('application/json');
    await expect(blob.text()).resolves.toBe('{"route":"/"}');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['refuses the beacon', { sendBeacon: () => false }],
    ['has no sendBeacon', {}],
  ])('falls back to fetch with keepalive when the browser %s', (_case, browser) => {
    vi.stubGlobal('navigator', browser);
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('the page is going away')));
    vi.stubGlobal('fetch', fetchMock);

    send('{"route":"/"}');

    expect(fetchMock).toHaveBeenCalledWith(WEB_VITALS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"route":"/"}',
      keepalive: true,
      credentials: 'same-origin',
    });
    // A failed report is dropped without an unhandled rejection.
  });
});

describe('reportWebVitals', () => {
  it('measures the five metrics and sends them when the page is hidden, labelled by route pattern', () => {
    const transport = vi.fn();
    reportWebVitals('/admin/users', transport);
    expect([...observers.keys()].sort()).toEqual(['CLS', 'FCP', 'INP', 'LCP', 'TTFB']);

    observers.get('TTFB')?.(metric('TTFB', 90));
    observers.get('FCP')?.(metric('FCP', 700));
    // The library reports LCP, CLS and INP when the page is hidden, before the
    // app's own listener runs.
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    window.addEventListener(
      'visibilitychange',
      () => {
        observers.get('LCP')?.(metric('LCP', 1500));
        observers.get('CLS')?.(metric('CLS', 0));
      },
      { capture: true, once: true },
    );
    document.dispatchEvent(new Event('visibilitychange'));

    expect(transport).toHaveBeenCalledTimes(1);
    const body = JSON.parse(transport.mock.calls[0]?.[0] as string) as {
      route: string;
      metrics: { name: string }[];
    };
    expect(body.route).toBe('/admin/users');
    expect(body.metrics.map(({ name }) => name)).toEqual(['TTFB', 'FCP', 'LCP', 'CLS']);
    expect(JSON.stringify(body)).not.toContain('token');

    // pagehide right after: nothing left to send.
    window.dispatchEvent(new Event('pagehide'));
    expect(transport).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it('does not send while the page stays visible', () => {
    const transport = vi.fn();
    reportWebVitals('/', transport);
    observers.get('FCP')?.(metric('FCP', 700));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(transport).not.toHaveBeenCalled();
  });
});

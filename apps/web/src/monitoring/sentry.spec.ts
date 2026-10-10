import type { Breadcrumb, ErrorEvent } from '@sentry/browser';
import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn() }));
vi.mock('@sentry/browser', () => sdk);

const { DATA_COLLECTION, initSentry, scrubBreadcrumb, scrubEvent, withoutQuery } =
  await import('./sentry');

describe('initSentry', () => {
  it('starts errors-only tracking that collects nothing on its own', () => {
    const send = initSentry({
      dsn: 'https://key@o1.ingest.example.com/1',
      sampleRate: 1,
      environment: 'staging',
      release: 'abc1234',
    });
    expect(sdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://key@o1.ingest.example.com/1',
        environment: 'staging',
        release: 'abc1234',
        dataCollection: DATA_COLLECTION,
        beforeSend: scrubEvent,
        beforeBreadcrumb: scrubBreadcrumb,
      }),
    );
    for (const [category, value] of Object.entries(DATA_COLLECTION)) {
      expect([category, JSON.stringify(value)]).toEqual([
        category,
        expect.not.stringContaining('true'),
      ]);
    }
    const error = new Error('render failed');
    send(error, { source: 'route' });
    expect(sdk.captureException).toHaveBeenCalledWith(error, { tags: { source: 'route' } });
  });
});

describe('scrubbing', () => {
  it('keeps a page URL without its query string, and a user as an id', () => {
    const event = {
      request: {
        url: 'https://app.example.com/reset?token=abc#x',
        headers: { Cookie: 'has_session=1' },
      },
      user: { id: 'u1', email: 'a@example.com', ip_address: '203.0.113.7' },
    } as unknown as ErrorEvent;
    expect(scrubEvent(event)).toMatchObject({
      request: { url: 'https://app.example.com/reset' },
      user: { id: 'u1' },
    });
    expect(JSON.stringify(event)).not.toMatch(/token|Cookie|email|ip_address/);
  });

  it('drops console breadcrumbs and strips URLs and secret-looking fields from the rest', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'debug output' })).toBeNull();
    const fetchCrumb: Breadcrumb = {
      category: 'fetch',
      data: { url: '/api/users?email=a@example.com', status_code: 200, token: 'x' },
    };
    expect(scrubBreadcrumb(fetchCrumb)?.data).toEqual({ url: '/api/users', status_code: 200 });
    const navigation: Breadcrumb = {
      category: 'navigation',
      data: { from: '/sign-in?next=%2Fadmin', to: '/admin?code=123' },
    };
    expect(scrubBreadcrumb(navigation)?.data).toEqual({ from: '/sign-in', to: '/admin' });
  });

  it('cuts a URL at its query string or fragment', () => {
    expect(withoutQuery('/a/b?c=d')).toBe('/a/b');
    expect(withoutQuery('/a#hash')).toBe('/a');
    expect(withoutQuery('/plain')).toBe('/plain');
  });
});

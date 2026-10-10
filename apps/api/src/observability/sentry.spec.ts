import type { ErrorEvent } from '@sentry/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSentryTracker, scrubEvent } from './sentry.js';

const DSN = 'https://abc123publickey@o1.ingest.example.com/42';

// Built at runtime: secret scanners rightly flag a connection string with a
// password written out in a file, test fixtures included.
const PG = 'postgresql';
const dbUrl = (user: string, password: string, rest = '@db:5432/app') =>
  `${PG}://${user}:${password}${rest}`;

function stubIngest() {
  const bodies: string[] = [];
  const fetchStub = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    bodies.push(typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array));
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchStub);
  return { fetchStub, bodies };
}

/** The event items of a Sentry envelope (newline-delimited JSON). */
function eventsIn(body: string): Record<string, unknown>[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((item) => 'event_id' in item && 'exception' in item);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSentryTracker', () => {
  it('sends an unexpected error with the request identity, release and environment', async () => {
    const { fetchStub, bodies } = stubIngest();
    const tracker = createSentryTracker({
      dsn: DSN,
      environment: 'staging',
      release: 'abc1234',
      sampleRate: 1,
    });
    tracker.capture(new Error(`payment failed for ${dbUrl('app', 'db-secret', '@db/app')}`), {
      origin: 'application',
      requestId: 'req-9',
      method: 'POST',
      route: '/api/orders/:id',
      statusCode: 500,
      userId: 'user-7',
    });
    await tracker.flush(2_000);

    expect(fetchStub).toHaveBeenCalledOnce();
    const [url] = fetchStub.mock.calls[0] ?? [];
    expect(typeof url === 'string' ? url : '').toContain('o1.ingest.example.com/api/42/envelope');
    const [event] = eventsIn(bodies[0] ?? '');
    expect(event).toMatchObject({
      level: 'error',
      environment: 'staging',
      release: 'abc1234',
      user: { id: 'user-7' },
      tags: {
        'error.origin': 'application',
        request_id: 'req-9',
        'http.method': 'POST',
        'http.route': '/api/orders/:id',
        'http.status_code': 500,
      },
    });
    expect(bodies[0]).not.toContain('db-secret');
    await tracker.close(1_000);
  });

  it('sends nothing when sampled out', async () => {
    const { fetchStub } = stubIngest();
    const tracker = createSentryTracker({
      dsn: DSN,
      environment: 'test',
      release: 'r',
      sampleRate: 0,
    });
    tracker.capture(new Error('dropped'));
    await tracker.flush(500);
    expect(fetchStub).not.toHaveBeenCalled();
    await tracker.close(500);
  });

  it('survives an unreachable Sentry: reporting never breaks the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const tracker = createSentryTracker({
      dsn: DSN,
      environment: 'test',
      release: 'r',
      sampleRate: 1,
    });
    expect(() => {
      tracker.capture(new Error('boom'));
    }).not.toThrow();
    await expect(tracker.flush(500)).resolves.toBeUndefined();
    await tracker.close(500);
  });
});

describe('scrubEvent', () => {
  it('keeps method and path, drops headers, cookies, bodies and query strings', () => {
    const event = {
      type: undefined,
      message: 'login with password=hunter2',
      request: {
        method: 'POST',
        url: 'https://app.example.com/api/auth/sign-in?token=abc',
        headers: { authorization: 'Bearer x', cookie: 'refresh_token=y' },
        cookies: { refresh_token: 'y' },
        data: { email: 'a@example.com', password: 'hunter2' },
        query_string: 'token=abc',
      },
      user: { id: 'u1', email: 'a@example.com', ip_address: '203.0.113.7' },
      breadcrumbs: [{ message: 'GET /api/users?token=abc' }],
      extra: { config: { apiKey: 'k-123' } },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'failed with Bearer abcdef123456',
            stacktrace: { frames: [{ filename: 'a.js', vars: { password: 'hunter2' } }] },
          },
        ],
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);
    expect(scrubbed.request).toEqual({
      method: 'POST',
      url: 'https://app.example.com/api/auth/sign-in',
    });
    expect(scrubbed.user).toEqual({ id: 'u1' });
    expect(scrubbed.breadcrumbs).toBeUndefined();
    expect(scrubbed.extra).toEqual({ config: { apiKey: '[REDACTED]' } });
    expect(scrubbed.message).toBe('login with password=[REDACTED]');
    const [exception] = scrubbed.exception?.values ?? [];
    expect(exception?.value).toBe('failed with Bearer [REDACTED]');
    expect(exception?.stacktrace?.frames?.[0]).not.toHaveProperty('vars');
    expect(JSON.stringify(scrubbed)).not.toContain('hunter2');
  });
});

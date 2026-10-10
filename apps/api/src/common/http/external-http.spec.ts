import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { runWithRequestContext } from '../../observability/request-context.js';
import {
  backoff,
  createExternalHttpClient,
  ExternalServiceError,
  type ExternalHttpClientOptions,
} from './external-http.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

function clientWith(
  responses: (() => Promise<Response>)[],
  options: Partial<ExternalHttpClientOptions> = {},
) {
  const queue = [...responses];
  const fetchStub = vi.fn((_input: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected request');
    return next();
  });
  const sleep = vi.fn(() => Promise.resolve());
  const client = createExternalHttpClient({
    name: 'billing',
    baseUrl: 'https://billing.example.com/v1/',
    fetch: fetchStub,
    sleep,
    headers: () => ({ Authorization: 'Bearer billing-api-key-123' }),
    ...options,
  });
  return { client, fetchStub, sleep };
}

let warn: MockInstance<Logger['warn']>;
let debug: MockInstance<Logger['debug']>;
beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

describe('createExternalHttpClient', () => {
  it('sends JSON with credentials and the request id, and parses the answer', async () => {
    const { client, fetchStub } = clientWith([() => Promise.resolve(json({ id: 'inv_1' }))]);
    const response = await runWithRequestContext({ requestId: 'req-5' }, () =>
      client.request<{ id: string }>({ method: 'POST', path: 'invoices', body: { amount: 10 } }),
    );
    expect(response).toMatchObject({ status: 200, body: { id: 'inv_1' } });
    const [url, init] = fetchStub.mock.calls[0] ?? [];
    expect(url).toEqual(new URL('https://billing.example.com/v1/invoices'));
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer billing-api-key-123');
    expect(headers.get('X-Request-Id')).toBe('req-5');
    expect(init?.body).toBe('{"amount":10}');
  });

  it('retries idempotent requests on 503 and network failures, honoring Retry-After', async () => {
    const { client, sleep } = clientWith([
      () => Promise.resolve(json({}, 503, { 'Retry-After': '2' })),
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.resolve(json({ ok: true })),
    ]);
    await expect(client.request({ path: 'status' })).resolves.toMatchObject({ body: { ok: true } });
    expect(sleep).toHaveBeenNthCalledWith(1, 2_000);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('reads Retry-After as an HTTP date too, and caps the wait', async () => {
    const inAMinute = new Date(Date.now() + 60_000).toUTCString();
    const { client, sleep } = clientWith([
      () => Promise.resolve(json({}, 429, { 'Retry-After': inAMinute })),
      () => Promise.resolve(json({})),
    ]);
    await client.request({ path: 'rates' });
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('never retries a POST without an idempotency guarantee', async () => {
    const { client, fetchStub } = clientWith([() => Promise.resolve(json({}, 503))]);
    await expect(
      client.request({ method: 'POST', path: 'charges', body: {} }),
    ).rejects.toMatchObject({
      kind: 'status',
      status: 503,
    });
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('does not retry client errors', async () => {
    const { client, fetchStub } = clientWith([() => Promise.resolve(json({}, 404))]);
    await expect(client.request({ path: 'invoices/missing' })).rejects.toMatchObject({
      name: 'ExternalServiceError',
      dependency: 'billing',
      status: 404,
    });
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('reports a timeout as such, after the retries', async () => {
    const timeout = () =>
      Promise.reject(new DOMException('The operation timed out', 'TimeoutError'));
    const { client } = clientWith([timeout, timeout, timeout]);
    const failure = client.request({ path: 'slow' });
    await expect(failure).rejects.toBeInstanceOf(ExternalServiceError);
    await expect(failure).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('logs method and path only: no query string, no headers', async () => {
    const { client } = clientWith([
      () => Promise.resolve(json({}, 200)),
      () => Promise.resolve(json({}, 400)),
    ]);
    await client.request({ path: 'search', query: { email: 'a@example.com' } });
    await client.request({ path: 'search', query: { token: 'abc' } }).catch(() => undefined);
    const lines = [...debug.mock.calls, ...warn.mock.calls].map(([line]) => String(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^GET \/v1\/search 200 \d+ms attempts=1$/);
    expect(lines[1]).toMatch(/^GET \/v1\/search 400 \d+ms attempts=1$/);
    expect(lines.join(' ')).not.toMatch(/email|token|Bearer/);
  });

  it('refuses a path that would leave the configured host (SSRF)', async () => {
    const { client, fetchStub } = clientWith([]);
    await expect(client.request({ path: 'https://attacker.example.net/' })).rejects.toThrow(
      'leaves',
    );
    await expect(client.request({ path: '//attacker.example.net/x' })).rejects.toThrow('leaves');
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('paths', () => {
  const BACKSLASH = String.fromCharCode(92);
  /** The URL the client sent the request to. */
  const urlOf = async (
    baseUrl: string,
    path: string | string[],
    query?: Record<string, string>,
  ) => {
    const { client, fetchStub } = clientWith([() => Promise.resolve(json({}))], { baseUrl });
    await client.request({ path, query });
    const sent = fetchStub.mock.calls[0]?.[0];
    if (!(sent instanceof URL)) throw new Error('the client sends a URL object');
    return sent.href;
  };

  it("keeps the base URL's path, with or without its trailing slash", async () => {
    await expect(urlOf('https://billing.example.com/v1', 'invoices')).resolves.toBe(
      'https://billing.example.com/v1/invoices',
    );
    await expect(urlOf('https://billing.example.com/v1/', 'invoices')).resolves.toBe(
      'https://billing.example.com/v1/invoices',
    );
    await expect(urlOf('https://billing.example.com/api/v2', ['invoices', 'inv_1'])).resolves.toBe(
      'https://billing.example.com/api/v2/invoices/inv_1',
    );
    await expect(urlOf('https://billing.example.com', 'invoices')).resolves.toBe(
      'https://billing.example.com/invoices',
    );
  });

  it('refuses a path that starts with "/": it would drop the base path', async () => {
    const { client, fetchStub } = clientWith([]);
    await expect(client.request({ path: '/invoices/1' })).rejects.toThrow('relative');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('encodes each segment, so a value stays one segment of the path', async () => {
    await expect(
      urlOf('https://billing.example.com/v1/', ['invoices', '../admin?x=1#y', 'a b']),
    ).resolves.toBe('https://billing.example.com/v1/invoices/..%2Fadmin%3Fx%3D1%23y/a%20b');
    await expect(
      urlOf('https://billing.example.com/v1/', ['invoices', '%2e%2e', `..${BACKSLASH}x`, '.\t.']),
    ).resolves.toBe('https://billing.example.com/v1/invoices/%252e%252e/..%5Cx/.%09.');
  });

  it('adds the query to a path given as segments, like to any other', async () => {
    await expect(
      urlOf('https://billing.example.com/v1/', ['customers', 'c 1', 'invoices'], {
        status: 'open',
      }),
    ).resolves.toBe('https://billing.example.com/v1/customers/c%201/invoices?status=open');
  });

  it('refuses dot and empty segments, which would reach another resource', async () => {
    const { client, fetchStub } = clientWith([]);
    for (const path of [
      ['invoices', '..'],
      ['invoices', '.'],
      ['invoices', ''],
      'invoices/../admin',
      'invoices/%2e%2E/admin',
      'https://billing.example.com/v1/invoices/../../admin',
    ]) {
      await expect(client.request({ path })).rejects.toThrow(/segment|leaves/);
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('refuses a path the URL parser would read differently from the code', async () => {
    // In an http(s) URL "\" is "/", and tabs and newlines are dropped: each of
    // these would reach https://billing.example.com/v1/admin.
    const { client, fetchStub } = clientWith([]);
    for (const path of [
      ['invoices', '..', 'admin'].join(BACKSLASH),
      'invoices/.\t./admin',
      'invoices/.\n./admin',
      'invoices/.\r./admin',
    ]) {
      await expect(client.request({ path })).rejects.toThrow('backslash, a tab or a newline');
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('refuses a base URL with a query string or a fragment, which every path would drop', () => {
    expect(() =>
      createExternalHttpClient({ name: 'billing', baseUrl: 'https://billing.example.com/v1?k=1' }),
    ).toThrow('query');
    expect(() =>
      createExternalHttpClient({ name: 'billing', baseUrl: 'https://billing.example.com/v1#top' }),
    ).toThrow('fragment');
  });
});

describe('backoff', () => {
  it('doubles from 200 ms, capped at 5 s, plus jitter', () => {
    expect([1, 2, 3].map((attempt) => backoff(attempt, () => 0))).toEqual([200, 400, 800]);
    expect(backoff(20, () => 0)).toBe(5_000);
  });
});

describe('a failure while reading the response body', () => {
  const answering = (response: () => Response) =>
    createExternalHttpClient({
      name: 'billing',
      baseUrl: 'https://billing.example.com/v1/',
      fetch: () => Promise.resolve(response()),
      sleep: () => Promise.resolve(),
    });

  it('is an ExternalServiceError (502 kind) with its log line when the JSON is cut off', async () => {
    const client = answering(
      () =>
        new Response('{"id":"inv_1","amount":', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const error: unknown = await client
      .request({ path: 'invoices/inv_1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).kind).toBe('network');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('is a timeout (504 kind) when the body stream times out mid-read', async () => {
    const client = answering(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"items":['));
          controller.error(new DOMException('The operation timed out.', 'TimeoutError'));
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const error: unknown = await client.request({ path: 'invoices' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).kind).toBe('timeout');
  });
});

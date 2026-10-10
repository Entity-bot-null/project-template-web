import { Logger } from '@nestjs/common';
import { recordDependencyCall } from '../../observability/metrics.js';
import { currentRequestId } from '../../observability/request-context.js';
import { REQUEST_ID_HEADER } from '../logging/request-context.middleware.js';

// The one way the API calls an external service (docs/observability.md#external-services).
// Every call gets, without the caller thinking about it:
//   - a timeout per attempt (a slow dependency must not hold requests forever);
//   - retries with backoff and jitter, only for idempotent requests and only
//     for failures worth retrying (network, timeout, 429, 502-504), honoring
//     Retry-After;
//   - correlation: the current X-Request-Id, and the W3C trace context when
//     tracing is on (injected by the fetch instrumentation);
//   - one metric (app.dependency.duration: dependency, outcome, status) and one
//     log line, with the method and path only: never headers, query strings
//     or bodies, which carry API keys and personal data;
//   - an ExternalServiceError on failure, which the error filter answers with
//     502/504 and reports as a dependency failure, not an application bug.
//
//   const billing = createExternalHttpClient({
//     name: 'billing', baseUrl: env.BILLING_URL, // https://billing.example.com/v1
//     headers: () => ({ Authorization: `Bearer ${env.BILLING_API_KEY}` }),
//   });
//   // GET https://billing.example.com/v1/invoices/<id, encoded>
//   const { body } = await billing.request<Invoice>({ path: ['invoices', id] });

export type FailureKind = 'timeout' | 'network' | 'status';

/** An external service failed: timed out, unreachable, or answered with an error status. */
export class ExternalServiceError extends Error {
  constructor(
    readonly dependency: string,
    readonly kind: FailureKind,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(`${dependency}: ${kind === 'status' ? `HTTP ${String(status)}` : kind}`, options);
    this.name = 'ExternalServiceError';
  }
}

type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ExternalRequest {
  method?: Method;
  /**
   * Relative to baseUrl, without a leading "/" (which would drop the base
   * path), and never outside it: a fixed path written in the code
   * ('invoices'), or segments (['invoices', id]), each one encoded, so a value
   * holding "/", "?" or "#" stays one segment. Never interpolate a value into
   * a string path.
   */
  path: string | readonly string[];
  query?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Safe to send twice. Default: true for GET, HEAD, PUT and DELETE, false for
   * POST and PATCH (pass true with an idempotency key the service honors).
   */
  idempotent?: boolean;
}

export interface ExternalResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

export interface ExternalHttpClientOptions {
  /** Low-cardinality name: metric attribute, log field, error report tag. */
  name: string;
  /**
   * From configuration, never from user input (SSRF). Its path is kept, with
   * or without a trailing "/"; no query string or fragment.
   */
  baseUrl: string;
  /** Per attempt. */
  timeoutMs?: number;
  /** Extra attempts for retryable failures of idempotent requests. */
  retries?: number;
  /** Headers on every request, e.g. credentials read from env. Never logged. */
  headers?: () => Record<string, string>;
  /** Tests inject these. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 5_000;
const IDEMPOTENT_METHODS = new Set<Method>(['GET', 'HEAD', 'PUT', 'DELETE']);

export interface ExternalHttpClient {
  request<T = unknown>(request: ExternalRequest): Promise<ExternalResponse<T>>;
}

export function createExternalHttpClient(options: ExternalHttpClientOptions): ExternalHttpClient {
  const logger = new Logger(`External:${options.name}`);
  const base = baseUrlOf(options.name, options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retries = options.retries ?? 2;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  return {
    async request<T>(request: ExternalRequest): Promise<ExternalResponse<T>> {
      const method = request.method ?? 'GET';
      const url = resolve(options.name, base, request.path);
      for (const [key, value] of Object.entries(request.query ?? {})) {
        url.searchParams.set(key, value);
      }
      const headers = new Headers({ ...options.headers?.(), ...request.headers });
      headers.set('Accept', 'application/json');
      const requestId = currentRequestId();
      if (requestId !== undefined) headers.set(REQUEST_ID_HEADER, requestId);
      let body: string | undefined;
      if (request.body !== undefined) {
        headers.set('Content-Type', 'application/json');
        body = JSON.stringify(request.body);
      }
      const attempts = (request.idempotent ?? IDEMPOTENT_METHODS.has(method)) ? retries + 1 : 1;

      const started = performance.now();
      const finish = (
        outcome: 'success' | 'http_error' | 'timeout' | 'network_error',
        attempt: number,
        status?: number,
      ) => {
        const seconds = (performance.now() - started) / 1000;
        recordDependencyCall(options.name, outcome, seconds, status);
        const line = `${method} ${url.pathname} ${status === undefined ? outcome : String(status)} ${Math.round(seconds * 1000)}ms attempts=${attempt}`;
        if (outcome === 'success') logger.debug(line);
        else logger.warn(line);
      };

      for (let attempt = 1; ; attempt += 1) {
        let response: Response;
        try {
          response = await doFetch(url, {
            method,
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'error',
          });
        } catch (error) {
          const kind: FailureKind =
            error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network';
          if (attempt < attempts) {
            await sleep(backoff(attempt));
            continue;
          }
          finish(kind === 'timeout' ? 'timeout' : 'network_error', attempt);
          throw new ExternalServiceError(options.name, kind, undefined, { cause: error });
        }

        if (!response.ok) {
          if (attempt < attempts && RETRYABLE_STATUS.has(response.status)) {
            await response.body?.cancel();
            await sleep(retryAfter(response) ?? backoff(attempt));
            continue;
          }
          await response.body?.cancel();
          finish('http_error', attempt, response.status);
          throw new ExternalServiceError(options.name, 'status', response.status);
        }

        // The body can fail too (cut off, malformed JSON, the timeout firing
        // mid-read): a dependency failure like the others, with its log line,
        // metric and 502/504, never a raw SyntaxError reported as our bug.
        let parsed: unknown;
        try {
          parsed = await readBody(response);
        } catch (error) {
          const kind: FailureKind =
            error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network';
          finish(kind === 'timeout' ? 'timeout' : 'network_error', attempt, response.status);
          throw new ExternalServiceError(options.name, kind, response.status, { cause: error });
        }
        finish('success', attempt, response.status);
        return { status: response.status, headers: response.headers, body: parsed as T };
      }
    },
  };
}

/**
 * The base URL, its path ending with "/": a relative path then extends it
 * (`v1/` + `invoices` is `v1/invoices`) instead of replacing its last segment.
 */
function baseUrlOf(name: string, baseUrl: string): URL {
  const base = new URL(baseUrl);
  if (base.search !== '' || base.hash !== '') {
    throw new Error(
      `${name}: baseUrl must not have a query string or a fragment (every request would drop them)`,
    );
  }
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
  return base;
}

// A dot segment as the URL parser reads one: ".", "..", or a percent-encoded
// spelling ("%2e", ".%2E"...).
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
// Characters the URL parser reads differently from what the code shows: in an
// http(s) URL a backslash is a "/", and tabs and newlines are dropped (".\t."
// is "..").
const MISREAD = /[\\\t\n\r]/;

/** The request URL: under the base URL, or an error before anything is sent. */
function resolve(name: string, base: URL, path: string | readonly string[]): URL {
  const relative =
    typeof path === 'string'
      ? checkedPath(name, base, path)
      : path.map((segment) => encodedSegment(name, segment)).join('/');
  const url = new URL(relative, base);
  // The last word, whatever the parser made of the path: the same origin
  // (SSRF), under the base path.
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new Error(`${name}: path "${relative}" leaves ${base.origin}${base.pathname}`);
  }
  return url;
}

/** A path written in the code, refused when it would not mean what it shows under the base path. */
function checkedPath(name: string, base: URL, path: string): string {
  if (path.startsWith('/')) {
    throw new Error(
      `${name}: path "${path}" starts with "/", which leaves the base path ${base.pathname}: make it relative`,
    );
  }
  if (MISREAD.test(path)) {
    throw new Error(`${name}: path "${path}" has a backslash, a tab or a newline`);
  }
  const segments = path.split(/[?#]/, 1)[0]?.split('/') ?? [];
  if (segments.some((segment) => DOT_SEGMENT.test(segment))) {
    throw new Error(`${name}: path "${path}" has a "." or ".." segment`);
  }
  return path;
}

/** One segment of the path, encoded: "/", "?", "#", "\" and "%" in a value stay in it. */
function encodedSegment(name: string, segment: string): string {
  // Encoding leaves dots alone: "." and ".." would still move up the path,
  // and an empty segment would reach the collection instead of an item.
  if (segment === '' || segment === '.' || segment === '..') {
    throw new Error(`${name}: path segment "${segment}" would reach another resource`);
  }
  return encodeURIComponent(segment);
}

/** 200 ms, 400 ms, 800 ms... plus jitter, capped. */
export function backoff(attempt: number, random: () => number = Math.random): number {
  return Math.min(200 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS) + Math.floor(random() * 100);
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('Retry-After');
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_DELAY_MS);
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? undefined
    : Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS);
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text === '') return undefined;
  const type = response.headers.get('Content-Type') ?? '';
  return type.includes('json') ? (JSON.parse(text) as unknown) : text;
}

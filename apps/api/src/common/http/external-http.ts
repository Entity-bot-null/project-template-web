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
//     name: 'billing', baseUrl: env.BILLING_URL,
//     headers: () => ({ Authorization: `Bearer ${env.BILLING_API_KEY}` }),
//   });
//   const { body } = await billing.request<Invoice>({ path: `/invoices/${id}` });

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
  /** Relative to baseUrl; it can never point at another host. */
  path: string;
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
  /** From configuration, never from user input (SSRF). */
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
  const base = new URL(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retries = options.retries ?? 2;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  return {
    async request<T>(request: ExternalRequest): Promise<ExternalResponse<T>> {
      const method = request.method ?? 'GET';
      const url = new URL(request.path, base);
      if (url.origin !== base.origin) {
        throw new Error(`${options.name}: path "${request.path}" leaves ${base.origin}`);
      }
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

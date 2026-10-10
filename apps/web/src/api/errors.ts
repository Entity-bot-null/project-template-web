// Every API error is a { data: null, message } envelope with an HTTP status.
// `call` folds an openapi-fetch result, or a thrown network error, into one
// plain shape the screens switch on (docs/error-handling.md).

export interface ApiFailure {
  /**
   * HTTP status; 0 when no response arrived (offline, DNS, CORS, a timeout);
   * 502 when a success answer was not the API's envelope.
   */
  status: number;
  /** The server's message, for logs and developers. Not shown to users as is. */
  message: string;
  /** From Retry-After on a 429, when the server sent one. */
  retryAfterSec?: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; failure: ApiFailure };

export const NETWORK_ERROR_MESSAGE = 'Could not reach the server. Check your connection and retry.';
export const NOT_AN_ENVELOPE_MESSAGE = 'The success answer was not the API envelope';

// The success body is the envelope. `data` is optional in the type because
// generated types drop a payload that is always null.
interface FetchOutcome<T> {
  data?: { data?: T; message: string };
  error?: unknown;
  response: Response;
}

export async function call<T>(request: Promise<FetchOutcome<T>>): Promise<ApiResult<T>> {
  let outcome: FetchOutcome<T>;
  try {
    outcome = await request;
  } catch {
    return { ok: false, failure: { status: 0, message: NETWORK_ERROR_MESSAGE } };
  }
  if (outcome.response.ok) {
    // 204 No Content is the one success without an envelope: it folds to null.
    if (outcome.response.status === 204) return { ok: true, data: null as T };
    // Any other success without one did not come from the API (a proxy, a
    // captive portal or a deploy in progress answering for it): a failure, as
    // from a bad gateway, never data a screen would trust.
    if (!isEnvelope(outcome.data)) {
      return { ok: false, failure: { status: 502, message: NOT_AN_ENVELOPE_MESSAGE } };
    }
    return { ok: true, data: (outcome.data.data ?? null) as T };
  }
  return { ok: false, failure: failureOf(outcome.response, outcome.error) };
}

// The API's envelope: { data, message }, data null when there is nothing.
function isEnvelope(body: unknown): body is { data: unknown; message: string } {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    'data' in body &&
    'message' in body &&
    typeof body.message === 'string'
  );
}

export function failureOf(response: Response, error: unknown): ApiFailure {
  const failure: ApiFailure = {
    status: response.status,
    message: messageOf(error) ?? `HTTP ${response.status}`,
  };
  if (response.status === 429) {
    const seconds = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
    if (Number.isInteger(seconds) && seconds > 0) failure.retryAfterSec = seconds;
  }
  return failure;
}

function messageOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return undefined;
}

// User-facing text for a failure a screen did not map itself, by status.
export function describeFailure(failure: ApiFailure): string {
  if (failure.status === 0) return NETWORK_ERROR_MESSAGE;
  if (failure.status === 400) return 'Check the highlighted data and try again.';
  if (failure.status === 401) return 'Your session has ended. Sign in again.';
  if (failure.status === 403) return 'You do not have access to this.';
  if (failure.status === 404) return 'Not found.';
  if (failure.status === 429) {
    return failure.retryAfterSec
      ? `Too many attempts. Wait ${failure.retryAfterSec} seconds and retry.`
      : 'Too many attempts. Wait a moment and retry.';
  }
  if (failure.status >= 500) return 'The service is unavailable. Try again later.';
  return `Something went wrong (${failure.status}).`;
}

import { vi } from 'vitest';
import type { AuthUser } from '../auth';
import { member } from './fixtures';

// HTTP mocks for the specs: global fetch replaced by a router keyed on
// "METHOD /path", answering with the API's { data, message } envelopes.
// Nothing leaves the process; an unexpected request fails the test.

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const ok = (data: unknown, message = 'Operation successful') => json(200, { data, message });

export const failure = (status: number, message: string, headers?: Record<string, string>) =>
  json(status, { data: null, message }, headers);

export const session = (accessToken: string, user: AuthUser = member) =>
  ok({ accessToken, expiresIn: 900, user });

type Handler = (request: Request) => Response | Promise<Response>;

export function stubFetch(handlers: Record<string, Handler>) {
  const calls: Request[] = [];
  const fetchMock = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push(request);
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`Unexpected request ${key}`);
    return handler(request);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

/** A promise the test resolves when it chooses: holds a response in flight. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// The readable cookie the API sets next to the refresh cookie; boot only asks
// the server for a session when it is present.
export function setSessionHint(): void {
  document.cookie = 'has_session=1; path=/';
}

export function clearSessionHint(): void {
  document.cookie = 'has_session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

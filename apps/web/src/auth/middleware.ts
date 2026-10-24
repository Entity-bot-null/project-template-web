import type { Middleware } from 'openapi-fetch';

export interface TokenStore {
  getAccessToken(): string | null;
  /** The signed-in user's id; null when anonymous. */
  getUserId(): string | null;
  refresh(): Promise<boolean>;
  clearSession(): void;
}

interface Sent {
  /** A copy kept until the response decides on a replay: a body reads once. */
  replay: Request;
  token: string;
  userId: string | null;
}

// Attaches the bearer token to every request outside /api/auth and, when one
// comes back 401 (the access token expired), refreshes once and replays it
// with the new token. A second 401 means the session is gone: sign out so the
// route guards send the user to sign-in. One refresh and one replay at most,
// so a broken session can never loop.
//
// Only a request that carried a token gets a refresh. If another request
// refreshed in the meantime, the replay uses that token instead of rotating
// again. And a request is never replayed for another user than the one who
// sent it: another tab may have signed in as someone else meanwhile.
//
// The auth routes are excluded: they are anonymous, and a 401 from sign-in or
// refresh is an answer, not an expired token.
export function createAuthMiddleware(store: TokenStore): Middleware {
  const isAuthRoute = (schemaPath: string) => schemaPath.startsWith('/api/auth/');
  const inFlight = new Map<string, Sent>();

  return {
    onRequest({ request, schemaPath, id }) {
      if (isAuthRoute(schemaPath)) return undefined;
      const token = store.getAccessToken();
      if (token === null) return undefined;
      request.headers.set('Authorization', `Bearer ${token}`);
      inFlight.set(id, { replay: request.clone(), token, userId: store.getUserId() });
      return undefined;
    },
    async onResponse({ response, id, options }) {
      const sent = inFlight.get(id);
      inFlight.delete(id);
      if (response.status !== 401 || !sent) return undefined;

      if (store.getAccessToken() === sent.token && !(await store.refresh())) {
        // Signed out by the refresh (401/403): the 401 stands, "session ended".
        // Still signed in (the refresh failed for a transient reason: a server
        // error, a rate limit, offline): the session is kept, so the request
        // fails as unavailable, never with "session ended".
        return store.getUserId() === null ? undefined : renewalUnavailable();
      }
      const token = store.getAccessToken();
      if (token === null || store.getUserId() !== sent.userId) return undefined;

      const retry = new Request(sent.replay);
      retry.headers.set('Authorization', `Bearer ${token}`);
      const second = await options.fetch(retry);
      // Refused again: the session is gone, unless a newer one replaced it
      // meanwhile (a password change answered while the replay was on its way).
      if (second.status === 401 && store.getAccessToken() === token) store.clearSession();
      return second;
    },
    onError({ id }) {
      inFlight.delete(id);
    },
  };
}

/** The answer a request gets when its renewal failed but the session is kept. */
function renewalUnavailable(): Response {
  return new Response(
    JSON.stringify({ data: null, message: 'The session could not be renewed right now' }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );
}

import { api } from '../api/client';
import { type ApiResult, call } from '../api/errors';
import { createAuthMiddleware } from './middleware';
import type { AuthSession, AuthState } from './types';

// The session store (docs/security.md#authentication-and-tokens). The access token lives in this
// module's memory and nowhere else: never localStorage or sessionStorage,
// where any injected script could read it. The refresh token is an httpOnly
// cookie the browser sends by itself (in production `__Host-refresh_token` on
// Path=/, in development `refresh_token` scoped to /api/auth; only the
// sign-in, refresh and logout routes read it, sign-in to end the session it
// replaces). A page load therefore
// starts with one refresh (`boot`), and every caller (boot, the 401
// middleware, racing tabs) shares the same in-flight refresh: the server
// rotates refresh tokens, so two parallel refreshes would race.

const LOADING: AuthState = { status: 'loading', user: null };
const ANONYMOUS: AuthState = { status: 'anonymous', user: null };
const SIGNED_OUT: AuthState = { status: 'anonymous', user: null, signedOut: 'done' };

let accessToken: string | null = null;
let state: AuthState = LOADING;
let refreshInFlight: Promise<boolean> | null = null;
let logoutInFlight: Promise<boolean> | null = null;
let signInInFlight: Promise<ApiResult<AuthSession>> | null = null;
let booted = false;
// Bumped by every sign-in and sign-out: a refresh already running when one
// happens must not overwrite its outcome when it lands.
let epoch = 0;
const listeners = new Set<() => void>();

function emit(next: AuthState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getState(): AuthState {
  return state;
}

function getUserId(): string | null {
  return state.status === 'authenticated' ? state.user.id : null;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stores a session answered by sign-in or refresh. */
export function setSession(session: AuthSession): void {
  accessToken = session.accessToken;
  emit({ status: 'authenticated', user: session.user });
}

/** Forgets the session locally; the cookie is the server's business. */
export function clearSession(): void {
  accessToken = null;
  emit(ANONYMOUS);
}

/**
 * Trades the refresh cookie for a new access token. Single-flighted: while a
 * refresh runs, every caller gets the same promise. Resolves false when there
 * is no session to renew (and then signs out locally) or when the server
 * could not answer.
 */
export function refresh(): Promise<boolean> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// Tabs share the refresh cookie and every refresh rotates it, so they refresh
// one at a time (a Web Lock): no tab ever presents a token another one has
// just rotated. Without Web Locks (an old browser, an insecure context) two
// tabs can still race: the loser's 401 arrives after the winner's cookie is
// in the jar, and one retry with that cookie tells a race from a dead
// session. Only a 401 (or a 403) ends the session: a network failure or a
// server error leaves it as it was for the next request to try again, except
// at boot, which has to settle somewhere.
async function doRefresh(): Promise<boolean> {
  const started = epoch;
  let result = await refreshOnce();
  if (!result.ok && result.failure.status === 401 && epoch === started) {
    result = await refreshOnce();
  }
  // A sign-in or a sign-out happened meanwhile: its outcome stands.
  if (epoch !== started) return state.status === 'authenticated';
  if (result.ok && isSession(result.data)) {
    setSession(result.data);
    return true;
  }
  const ended = !result.ok && (result.failure.status === 401 || result.failure.status === 403);
  if (ended || state.status === 'loading') clearSession();
  return false;
}

/**
 * How long a refresh may take, answer included. It holds the cross-tab lock
 * meanwhile, so one that stalls (a hung connection, a stuck proxy) would keep
 * every tab from renewing its session; past this it fails like a network
 * error, and the next request tries again.
 */
export const REFRESH_TIMEOUT_MS = 10_000;

function refreshOnce(): Promise<ApiResult<AuthSession>> {
  let sent = false;
  const send = () => {
    sent = true;
    return call(api.POST('/api/auth/refresh', { signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) }));
  };
  if (!('locks' in navigator)) return send();
  // A browser can still refuse the lock (a sandboxed frame, a storage
  // policy): the tab then refreshes without it, like one without Web Locks.
  return navigator.locks.request('auth-refresh', send).catch((error: unknown) => {
    if (sent) throw error;
    return send();
  });
}

// The contract types the body, but something in between (a misconfigured
// proxy, a captive portal) can still answer 200 with something else.
function isSession(data: unknown): data is AuthSession {
  return (
    typeof data === 'object' &&
    data !== null &&
    'accessToken' in data &&
    typeof data.accessToken === 'string' &&
    'user' in data &&
    typeof data.user === 'object' &&
    data.user !== null
  );
}

// The API sets a readable `has_session` cookie next to the httpOnly refresh
// cookie and clears both together. It holds no secret, only the fact that a
// refresh is worth trying: without it the visitor is anonymous and boot
// settles at once, instead of asking the server and collecting a 401.
const SESSION_HINT_COOKIE = 'has_session';

function hasSessionHint(): boolean {
  return document.cookie.split('; ').some((entry) => entry.startsWith(`${SESSION_HINT_COOKIE}=`));
}

// Deleting a cookie takes the path it was set with, and Secure over HTTPS.
function expireSessionHint(): void {
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie = `${SESSION_HINT_COOKIE}=; path=/; max-age=0${secure}`;
}

/** The boot refresh, once per page load; safe to call repeatedly. */
export function boot(): Promise<boolean> {
  if (booted) return refreshInFlight ?? Promise.resolve(state.status === 'authenticated');
  booted = true;
  if (!hasSessionHint()) {
    clearSession();
    return Promise.resolve(false);
  }
  return refresh();
}

export async function signIn(email: string, password: string): Promise<ApiResult<AuthSession>> {
  const attempt = sendSignIn(email, password);
  signInInFlight = attempt;
  try {
    return await attempt;
  } finally {
    if (signInInFlight === attempt) signInInFlight = null;
  }
}

async function sendSignIn(email: string, password: string): Promise<ApiResult<AuthSession>> {
  // A logout or a rotation still on its way would overwrite the cookie this
  // sign-in sets: the logout clears it, a late rotation replaces it.
  if (logoutInFlight) await logoutInFlight;
  if (refreshInFlight) await refreshInFlight;
  const result = await call(api.POST('/api/auth/sign-in', { body: { email, password } }));
  // Checked like a refresh: a proxy, a captive portal or a deploy in progress
  // can answer 2xx with something that is not a session.
  if (result.ok && !isSession(result.data)) {
    return { ok: false, failure: { status: 502, message: 'The sign-in answer was not a session' } };
  }
  if (result.ok) {
    epoch += 1;
    setSession(result.data);
    tellOtherTabs('signed-in');
  }
  return result;
}

/**
 * Signs out: at once in this tab and the others, then on the server. Resolves
 * false when the server could not be reached. The refresh cookie may then
 * still be valid, so the state says so and the sign-in page offers a retry.
 */
export function signOut(): Promise<boolean> {
  epoch += 1;
  accessToken = null;
  // First, so a page closed right now leaves nothing the next visit restores.
  expireSessionHint();
  emit(SIGNED_OUT);
  tellOtherTabs('signed-out');
  return endServerSession();
}

/**
 * Asks the server again to end the session, after a failed sign-out. A
 * sign-in on its way goes first: the logout would carry the old cookie and
 * answer by clearing the cookies, the new one included if it landed after the
 * sign-in. A sign-in that succeeds has ended the old session itself (the
 * server retires the family of the cookie it presents); only a failed one
 * leaves the logout to do.
 */
export async function retrySignOut(): Promise<boolean> {
  if (signInInFlight) {
    await signInInFlight;
    if (state.status === 'authenticated') return true;
  }
  return endServerSession();
}

// The logout leaves at once, with keepalive so closing the page does not
// cancel it. It need not wait for a rotation in flight: any token of the
// family, rotated or not, ends the whole family.
function endServerSession(): Promise<boolean> {
  logoutInFlight ??= call(api.POST('/api/auth/logout', { keepalive: true }))
    .then(({ ok }) => {
      if (state.status === 'anonymous') {
        emit(ok ? SIGNED_OUT : { status: 'anonymous', user: null, signedOut: 'failed' });
      }
      return ok;
    })
    .finally(() => {
      logoutInFlight = null;
    });
  return logoutInFlight;
}

// Tabs share the cookies but not this memory. A sign-out signs the other tabs
// out at once (they still hold an access token); a sign-in lets the anonymous
// ones pick the new session up with a refresh.
type TabMessage = 'signed-in' | 'signed-out';
const tabs = typeof BroadcastChannel === 'function' ? new BroadcastChannel('auth') : null;

function tellOtherTabs(message: TabMessage): void {
  tabs?.postMessage(message);
}

tabs?.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
  if (data === 'signed-out') {
    // Whatever this tab's state: an anonymous tab may be refreshing to pick
    // up the sign-in that just ended, and that refresh must not land.
    epoch += 1;
    accessToken = null;
    if (state.status !== 'anonymous') emit(SIGNED_OUT);
  } else if (data === 'signed-in' && state.status !== 'authenticated') {
    void refresh();
  }
});

/** Test seam: back to a fresh page load. */
export function resetForTests(): void {
  accessToken = null;
  state = LOADING;
  refreshInFlight = null;
  logoutInFlight = null;
  signInInFlight = null;
  booted = false;
  listeners.clear();
}

api.use(createAuthMiddleware({ getAccessToken, getUserId, refresh, clearSession }));

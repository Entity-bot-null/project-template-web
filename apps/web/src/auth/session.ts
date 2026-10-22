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
const SIGN_OUT_FAILED: AuthState = { status: 'anonymous', user: null, signedOut: 'failed' };

let accessToken: string | null = null;
let state: AuthState = LOADING;
let refreshInFlight: Promise<boolean> | null = null;
// The epoch the refresh in flight started in.
let refreshEpoch = 0;
// The logouts on their way, by the sessions they name ('' for the cookie's,
// whichever it is): a sign-out joins one of its own kind only, never a retry
// that names an older session.
const logoutsInFlight = new Map<string, Promise<boolean>>();
// Logouts of sessions this tab started and discarded (endDiscardedSession).
const discardsInFlight = new Set<Promise<unknown>>();
// Discarded sessions whose logout failed (their cookie may still be live in
// the jar): the sign-in page's retry names them too. `unnamedUnended`: one
// started by an answer of the previous release, which names none.
const unended = new Set<string>();
let unnamedUnended = false;
let signInInFlight: Promise<ApiResult<AuthSession>> | null = null;
let booted = false;
// Bumped by every sign-in and sign-out: a refresh already running when one
// happens must not overwrite its outcome when it lands.
let epoch = 0;
// Bumped by every session started, in this tab or (told) in another: a
// rotation that lands after a sign-out leaves the hint alone when a sign-in
// followed the sign-out, since the hint is that sign-in's.
let sessionsStarted = 0;
let sessionsAtSignOut = 0;
// The session the browser's refresh cookie holds, as far as this tab knows
// (AuthSession.sessionId, the same across refreshes): its own, or one another
// tab started and told about. A sign-out remembers it: a retried logout, and
// the logout of a session discarded after the sign-out, name it, so they end
// that session and never a newer one.
let browserSession: string | null = null;
let signedOutSession: string | null = null;
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
  browserSession = sessionIdOf(session);
  emit({ status: 'authenticated', user: session.user });
}

// An answer from the previous release, during a deployment, names no session.
function sessionIdOf(session: AuthSession): string | null {
  const id: unknown = session.sessionId;
  return typeof id === 'string' ? id : null;
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
  if (refreshInFlight === null) {
    refreshEpoch = epoch;
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
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
  // At boot a 429 says nothing about the session (everyone behind one address
  // shares the per-address limit): a short Retry-After is waited out once,
  // rather than show the sign-in page to someone who is signed in.
  const retryAfter = result.ok ? undefined : result.failure.retryAfterSec;
  if (
    !result.ok &&
    result.failure.status === 429 &&
    state.status === 'loading' &&
    retryAfter !== undefined &&
    retryAfter <= BOOT_RETRY_MAX_WAIT_SEC &&
    epoch === started
  ) {
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    if (epoch === started) result = await refreshOnce();
  }
  // A sign-in or a sign-out happened meanwhile: its outcome stands. After a
  // sign-out, a rotation that landed anyway has set the session hint again,
  // for a session the logout ends: dropped, so no page load tries it, unless
  // a sign-in followed the sign-out (the hint is then the new session's).
  if (epoch !== started) {
    if (result.ok && state.status === 'anonymous' && sessionsStarted === sessionsAtSignOut) {
      expireSessionHint();
    }
    return state.status === 'authenticated';
  }
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

/**
 * The longest Retry-After a boot waits out once. Longer, it settles as
 * anonymous like any other boot failure, rather than hold a loading page.
 */
const BOOT_RETRY_MAX_WAIT_SEC = 5;

/**
 * How long a sign-in (a sign-up confirmation, an invitation's acceptance) and
 * a logout may take, answer included. Like a refresh, each holds a cross-tab
 * lock meanwhile: one that stalled would keep every other tab from signing in
 * or renewing its session. Past this it fails like a network error.
 */
export const SESSION_REQUEST_TIMEOUT_MS = 20_000;

function refreshOnce(): Promise<ApiResult<AuthSession>> {
  return withLock(REFRESH_LOCK, () =>
    call(
      api.POST('/api/auth/refresh', {
        // The server rotates the token before it answers. A refresh the
        // browser abandoned (a reload, a navigation, a closed tab) would
        // leave the jar the old cookie: the next page load would present it
        // as a lost race and sign out, and 30 seconds later as theft, ending
        // the session family. keepalive lets the answer, and its new cookie,
        // land after the page is gone; the next page's one retry picks it up.
        keepalive: true,
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      }),
    ),
  );
}

// Requests that set or clear the shared refresh cookie go one tab at a time
// through two cross-tab Web Locks, so no answer lands after another tab's
// newer one and undoes it:
//   - REFRESH_LOCK, refreshes and sign-ins: a refresh answered after a
//     sign-in would put the old session's cookie back;
//   - SIGN_IN_LOCK, sign-ins and logouts: a logout answered after a sign-in
//     would clear the new session's cookie.
// A logout never waits for a refresh: any token of the family, rotated or not,
// ends the whole family, and a logout that waited would never leave a page
// closed meanwhile.
const REFRESH_LOCK = 'auth-refresh';
const SIGN_IN_LOCK = 'auth-sign-in';

async function withLock<T>(name: string, send: () => Promise<T>): Promise<T> {
  // A property, not a local: `start` sets it inside the lock's callback, where
  // control-flow analysis does not follow it.
  const attempt = { sent: false };
  const start = () => {
    attempt.sent = true;
    return send();
  };
  if (!('locks' in navigator)) return start();
  try {
    return await navigator.locks.request(name, start);
  } catch (error: unknown) {
    // A browser can still refuse the lock (a sandboxed frame, a storage
    // policy): the tab then sends without it, like one without Web Locks.
    if (attempt.sent) throw error;
    return start();
  }
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

export function signIn(email: string, password: string): Promise<ApiResult<AuthSession>> {
  return startSession(() =>
    call(
      api.POST('/api/auth/sign-in', {
        body: { email, password },
        signal: AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS),
      }),
    ),
  );
}

/**
 * Confirms a sign-up with its link's token and the password chosen with it:
 * the API creates the account and answers with its session, which starts
 * here exactly like a sign-in's.
 */
export function confirmSignUp(token: string, password: string): Promise<ApiResult<AuthSession>> {
  return startSession(() =>
    call(
      api.POST('/api/auth/sign-ups/confirm', {
        body: { token, password },
        signal: AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS),
      }),
    ),
  );
}

/**
 * Accepts an invitation with its link's token, choosing a name and a
 * password: the API creates the account (with the invitation's role) and
 * answers with its session, which starts here like a sign-in's.
 */
export function acceptInvitation(
  token: string,
  name: string,
  password: string,
): Promise<ApiResult<AuthSession>> {
  return startSession(() =>
    call(
      api.POST('/api/auth/invitations/accept', {
        body: { token, name, password },
        signal: AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS),
      }),
    ),
  );
}

// A request under /api/auth that answers with a new session and sets the
// refresh cookie (sign-in, sign-up confirmation, invitation). Tracked so a sign-out retry
// waits for it (retrySignOut).
async function startSession(
  send: () => Promise<ApiResult<AuthSession>>,
): Promise<ApiResult<AuthSession>> {
  const attempt = sendStartingSession(send);
  signInInFlight = attempt;
  try {
    return await attempt;
  } finally {
    if (signInInFlight === attempt) signInInFlight = null;
  }
}

async function sendStartingSession(
  send: () => Promise<ApiResult<AuthSession>>,
): Promise<ApiResult<AuthSession>> {
  // A logout or a rotation still on its way would overwrite the cookie this
  // sign-in sets: the logout clears it, a late rotation replaces it.
  await logoutsSettled();
  if (refreshInFlight) await refreshInFlight;
  // Read once both locks are held: a sign-out that came before this request
  // left is not one it raced.
  let started = epoch;
  // Another tab's refresh, sign-in or logout goes through the same locks.
  // These routes are under /api/auth, which the 401 middleware leaves alone:
  // nothing inside the locks waits for it.
  const result = await withLock(REFRESH_LOCK, () =>
    withLock(SIGN_IN_LOCK, () => {
      started = epoch;
      return send();
    }),
  );
  // Checked like a refresh: a proxy, a captive portal or a deploy in progress
  // can answer 2xx with something that is not a session.
  if (result.ok && !isSession(result.data)) {
    return { ok: false, failure: { status: 502, message: 'The sign-in answer was not a session' } };
  }
  if (!result.ok) return result;
  if (epoch !== started) {
    // Another tab signed out while this request was on its way: the sign-out
    // stands. The server did what was asked (an account may exist now), so
    // the answer is returned, but its session is not kept and ends there too.
    endDiscardedSession(result.data);
    return result;
  }
  epoch += 1;
  sessionsStarted += 1;
  setSession(result.data);
  // It presented the jar's cookie, whose session the server ended: a
  // discarded one whose logout failed included.
  unended.clear();
  unnamedUnended = false;
  tellOtherTabs('signed-in');
  tellSession();
  return result;
}

/**
 * Changes the signed-in user's password (POST /api/account/password). The
 * API ends every session of the account and answers with a new one, and a
 * new refresh cookie, for this browser: stored as a sign-in's is. A logout or
 * a rotation in flight goes first (its answer would overwrite the new
 * cookie), and the epoch moves on, so a refresh started meanwhile cannot put
 * the ended session back when it lands.
 *
 * Unlike a sign-in it does not take the cross-tab locks: it is an
 * authenticated request, and renewing an expired access token (the 401
 * middleware) takes REFRESH_LOCK, which would then wait for itself forever. A
 * renewal at that very instant (another tab's, or another request's of this
 * one) can therefore leave its older cookie in the jar. That session ended on
 * the server: the worst outcome is a sign-in with the new password, never a
 * session the change ended.
 *
 * A sign-out (here or in another tab) while it is on its way stands: the
 * session the change answers with is not kept, and ends on the server too.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<ApiResult<AuthSession>> {
  await logoutsSettled();
  if (refreshInFlight) await refreshInFlight;
  const started = epoch;
  const result = await call(
    api.POST('/api/account/password', { body: { currentPassword, newPassword } }),
  );
  if (result.ok && !isSession(result.data)) {
    return { ok: false, failure: { status: 502, message: 'The answer was not a session' } };
  }
  if (!result.ok) return result;
  if (epoch !== started) {
    // The password did change; the session this browser was given ends.
    endDiscardedSession(result.data);
    return result;
  }
  epoch += 1;
  sessionsStarted += 1;
  setSession(result.data);
  // A new session (the change ended every other one): the other tabs learn
  // its id, and pick it up when their access token is refused.
  tellSession();
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
  noteSignOut();
  // First, so a page closed right now leaves nothing the next visit restores.
  expireSessionHint();
  emit(SIGNED_OUT);
  tellOtherTabs('signed-out');
  return endServerSession();
}

// A tab that knew no session by then (signed out already) keeps the one its
// own sign-out ended: its retry still names it.
function noteSignOut(): void {
  signedOutSession = browserSession ?? signedOutSession;
  browserSession = null;
  sessionsAtSignOut = sessionsStarted;
}

/**
 * Asks the server again to end the session, after a failed sign-out. A
 * sign-in on its way goes first: the logout would carry the old cookie and
 * answer by clearing the cookies, the new one included if it landed after the
 * sign-in. A sign-in that succeeds has ended the old session itself (the
 * server retires the family of the cookie it presents); only a failed one
 * leaves the logout to do. The retry names the session the sign-out ended,
 * and every discarded one whose logout failed: another tab's sign-in queued
 * ahead of it (Web Locks) set a newer cookie, which it leaves alone. When one
 * of them is unknown (the previous release's), it ends the cookie's session,
 * whichever it is.
 */
export async function retrySignOut(): Promise<boolean> {
  if (signInInFlight) {
    await signInInFlight;
    if (state.status === 'authenticated') return true;
  }
  const signedOut = signedOutSession;
  return endServerSession(signedOut !== null && !unnamedUnended ? [signedOut, ...unended] : []);
}

// The logout leaves at once, with keepalive so closing the page does not
// cancel it. It never waits for a rotation in flight (any token of the family,
// rotated or not, ends the whole family), only for another tab's sign-in on
// its way (SIGN_IN_LOCK): a sign-in that succeeds ends the session it
// replaces, so a page closed meanwhile loses nothing then; one that fails
// leaves it to this logout, or to a retry. A sign-out ends the cookie's
// session, whichever it is (a tab may not know another's newer one); a retry
// names the sessions it ends (`names`). The state says the sign-out is done
// only once no discarded session's logout failed (its cookie may be live).
function endServerSession(names: readonly string[] = []): Promise<boolean> {
  const key = [...new Set(names)].sort().join(' ');
  const joined = logoutsInFlight.get(key);
  if (joined !== undefined) return joined;
  const ending = withLock(SIGN_IN_LOCK, () => sendLogout(names))
    .then(({ ok }) => {
      if (ok && names.length === 0) {
        // The cookie's session ended, whichever it was.
        unended.clear();
        unnamedUnended = false;
      } else if (ok) {
        for (const id of names) unended.delete(id);
      }
      if (state.status === 'anonymous') {
        emit(ok && unended.size === 0 && !unnamedUnended ? SIGNED_OUT : SIGN_OUT_FAILED);
      }
      return ok;
    })
    .finally(() => {
      if (logoutsInFlight.get(key) === ending) logoutsInFlight.delete(key);
    });
  logoutsInFlight.set(key, ending);
  return ending;
}

function sendLogout(sessionIds: readonly string[]): Promise<ApiResult<unknown>> {
  return call(
    api.POST('/api/auth/logout', {
      ...(sessionIds.length > 0 && { body: { sessionIds: [...new Set(sessionIds)] } }),
      keepalive: true,
      signal: AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS),
    }),
  );
}

// An answer that started a session, and set its cookie, after a sign-out it
// raced: that session is not kept, and ends on the server by a logout that
// names it (and the session the sign-out ended). Whatever else the jar holds
// by then, a session another tab started meanwhile, is left alone, and the
// server sets its hint back. The hint goes first, for a page closed
// meanwhile. Under SIGN_IN_LOCK, behind the sign-out's own logout: its answer
// clears the cookies, and no other tab's sign-in lands while it is on its way.
// A logout that fails leaves its cookie maybe live: the state says so, and
// the sign-in page's retry names it.
function endDiscardedSession(discarded: AuthSession): void {
  expireSessionHint();
  const id = sessionIdOf(discarded);
  const ending = withLock(SIGN_IN_LOCK, (): Promise<ApiResult<unknown>> => {
    if (id !== null) {
      return sendLogout(signedOutSession === null ? [id] : [id, signedOutSession]);
    }
    // An answer of the previous release names no session, and its logout
    // ends the cookie's: skipped when a newer session's answer set the hint
    // again since (this tab's sign-in, or another's: it held this lock),
    // its cookie having replaced this one's.
    if (hasSessionHint()) return Promise.resolve({ ok: true, data: null });
    return sendLogout([]);
  }).then(({ ok }) => {
    if (ok) return;
    if (id === null) unnamedUnended = true;
    else unended.add(id);
    if (state.status === 'anonymous') emit(SIGN_OUT_FAILED);
  });
  const tracked: Promise<unknown> = ending.finally(() => {
    discardsInFlight.delete(tracked);
  });
  discardsInFlight.add(tracked);
}

// A sign-in or a password change waits for every logout on its way: answered
// after it, a logout would clear the new session's cookie. With Web Locks the
// sign-in's lock already orders them; without, this does, in this tab.
async function logoutsSettled(): Promise<void> {
  await Promise.all([...logoutsInFlight.values(), ...discardsInFlight]);
}

// Tabs share the cookies but not this memory. A sign-out signs the other tabs
// out at once (they still hold an access token); a sign-in lets the anonymous
// ones pick the new session up with a refresh.
// `{ session }` names the browser's new session for the others' logouts (a
// tab of the previous release ignores it, and reads 'signed-in' as before).
type TabMessage = 'signed-in' | 'signed-out' | { session: string };
const tabs = typeof BroadcastChannel === 'function' ? new BroadcastChannel('auth') : null;

function tellOtherTabs(message: TabMessage): void {
  tabs?.postMessage(message);
}

function tellSession(): void {
  if (browserSession !== null) tellOtherTabs({ session: browserSession });
}

const isSessionMessage = (data: unknown): data is { session: string } =>
  typeof data === 'object' &&
  data !== null &&
  'session' in data &&
  typeof data.session === 'string';

tabs?.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
  if (data === 'signed-out') {
    // Whatever this tab's state: an anonymous tab may be refreshing to pick
    // up the sign-in that just ended, and that refresh must not land.
    epoch += 1;
    accessToken = null;
    noteSignOut();
    if (state.status !== 'anonymous') emit(SIGNED_OUT);
  } else if (data === 'signed-in') {
    sessionsStarted += 1;
    if (state.status !== 'authenticated') void pickUpSignIn();
  } else if (isSessionMessage(data)) {
    browserSession = data.session;
  }
});

// A refresh still on its way from before a sign-out has its answer dropped
// when it lands (the epoch moved on): the sign-in another tab just made is
// picked up by a refresh of its own, after it, rather than by joining it,
// unless another sign-out came meanwhile.
async function pickUpSignIn(): Promise<void> {
  const told = epoch;
  if (refreshInFlight !== null && refreshEpoch !== epoch) await refreshInFlight;
  // A sign-out came meanwhile: the sign-in it was told of has ended.
  if (epoch !== told) return;
  if (state.status !== 'authenticated') await refresh();
}

/** Test seam: back to a fresh page load. */
export function resetForTests(): void {
  accessToken = null;
  state = LOADING;
  refreshInFlight = null;
  logoutsInFlight.clear();
  discardsInFlight.clear();
  unended.clear();
  unnamedUnended = false;
  signInInFlight = null;
  browserSession = null;
  signedOutSession = null;
  sessionsAtSignOut = sessionsStarted;
  booted = false;
  listeners.clear();
}

api.use(createAuthMiddleware({ getAccessToken, getUserId, refresh, clearSession }));

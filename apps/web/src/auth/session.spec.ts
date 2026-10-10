import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { admin, member } from '../test/fixtures';
import {
  clearSessionHint,
  deferred,
  failure,
  ok,
  session,
  setSessionHint,
  stubFetch,
} from '../test/http';
import {
  boot,
  clearSession,
  getAccessToken,
  getState,
  refresh,
  REFRESH_TIMEOUT_MS,
  resetForTests,
  retrySignOut,
  setSession,
  signIn,
  signOut,
} from './session';

const ME = 'GET /api/users/me';
const REFRESH = 'POST /api/auth/refresh';
const SIGN_IN = 'POST /api/auth/sign-in';
const LOGOUT = 'POST /api/auth/logout';
const SIGNED_OUT = { status: 'anonymous', user: null, signedOut: 'done' };
const routeOf = (request: Request) => `${request.method} ${new URL(request.url).pathname}`;
const signedOut = () => new Response(null, { status: 204 });
// An answer that never comes: like fetch, it gives up only when the request's
// signal aborts.
const neverAnswered = (request: Request) =>
  new Promise<Response>((_resolve, reject) => {
    const abort = () => {
      reject(request.signal.reason as Error);
    };
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort);
  });

beforeEach(() => {
  resetForTests();
  setSessionHint();
});

afterEach(() => {
  resetForTests();
  clearSessionHint();
});

describe('refresh', () => {
  it('shares one in-flight request between concurrent callers', async () => {
    const gate = deferred<Response>();
    const { fetchMock } = stubFetch({ [REFRESH]: () => gate.promise });

    const results = Promise.all([refresh(), refresh(), boot()]);
    expect(getState().status).toBe('loading');
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    gate.resolve(session('token-1'));
    await expect(results).resolves.toEqual([true, true, true]);
    expect(getAccessToken()).toBe('token-1');
    expect(getState()).toEqual({ status: 'authenticated', user: member });
  });

  it('retries once after a 401: the lost race of two tabs refreshing together', async () => {
    let attempts = 0;
    const { fetchMock } = stubFetch({
      [REFRESH]: () => (attempts++ === 0 ? failure(401, 'already rotated') : session('token-1')),
    });
    await expect(refresh()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('signs out when the cookie is rejected twice', async () => {
    const { fetchMock } = stubFetch({ [REFRESH]: () => failure(401, 'Invalid session') });
    await expect(boot()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getState()).toEqual({ status: 'anonymous', user: null });
    expect(getAccessToken()).toBeNull();
  });

  it('keeps a session through a server error or a network failure', async () => {
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });
    stubFetch({ [REFRESH]: () => failure(503, 'Service unavailable') });
    await expect(refresh()).resolves.toBe(false);
    stubFetch({ [REFRESH]: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(refresh()).resolves.toBe(false);
    expect(getState()).toEqual({ status: 'authenticated', user: member });
    expect(getAccessToken()).toBe('token-1');
  });

  it('settles a boot as anonymous when the server cannot be reached', async () => {
    stubFetch({ [REFRESH]: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(boot()).resolves.toBe(false);
    expect(getState().status).toBe('anonymous');
  });

  it('refuses a success that is not a session', async () => {
    stubFetch({ [REFRESH]: () => ok({ unexpected: true }) });
    await expect(boot()).resolves.toBe(false);
    expect(getState().status).toBe('anonymous');
    expect(getAccessToken()).toBeNull();
  });

  it('never restores a session the user signed out of while it was refreshing', async () => {
    const gate = deferred<Response>();
    const { calls } = stubFetch({ [REFRESH]: () => gate.promise, [LOGOUT]: signedOut });
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });

    const refreshed = refresh();
    // The logout does not wait for the rotation: any token of the family ends it.
    await expect(signOut()).resolves.toBe(true);
    expect(calls.map(routeOf)).toEqual([REFRESH, LOGOUT]);
    gate.resolve(session('token-2'));
    await expect(refreshed).resolves.toBe(false);
    expect(getState()).toEqual(SIGNED_OUT);
    expect(getAccessToken()).toBeNull();
  });

  it('refreshes one tab at a time through a Web Lock when the browser has them', async () => {
    const held: string[] = [];
    const locks = {
      request: (name: string, work: () => Promise<unknown>) => {
        held.push(name);
        return work();
      },
    };
    vi.stubGlobal('navigator', { locks });
    stubFetch({ [REFRESH]: () => session('token-1') });
    await expect(refresh()).resolves.toBe(true);
    expect(held).toEqual(['auth-refresh']);
  });

  it('gives up on a refresh that does not answer in time and frees the lock for the next', async () => {
    // One stalled refresh would otherwise hold the cross-tab lock, and no tab
    // could renew its session until the page was closed.
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    // An exclusive lock, like the browser's: each holder waits for the last.
    let released: Promise<unknown> = Promise.resolve();
    const locks = {
      request: (_name: string, work: () => Promise<unknown>) => {
        const held = released.then(work);
        released = held.catch(() => undefined);
        return held;
      },
    };
    vi.stubGlobal('navigator', { locks });
    let attempts = 0;
    stubFetch({
      [REFRESH]: (request) => (attempts++ === 0 ? neverAnswered(request) : session('token-2')),
    });
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });

    const stalled = refresh();
    await vi.waitFor(() => {
      expect(timeout).toHaveBeenCalledWith(REFRESH_TIMEOUT_MS);
    });
    deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    // Like a network failure: the session stays for the next attempt.
    await expect(stalled).resolves.toBe(false);
    expect(getState()).toEqual({ status: 'authenticated', user: member });
    await expect(refresh()).resolves.toBe(true);
    expect(getAccessToken()).toBe('token-2');
  });

  it('settles a boot whose refresh does not answer in time as anonymous', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    stubFetch({
      [REFRESH]: neverAnswered,
    });
    const booted = boot();
    deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    await expect(booted).resolves.toBe(false);
    expect(getState()).toEqual({ status: 'anonymous', user: null });
  });

  it('refreshes without the lock when the browser refuses one', async () => {
    const locks = {
      request: () => Promise.reject(new DOMException('Access denied', 'SecurityError')),
    };
    vi.stubGlobal('navigator', { locks });
    const { calls } = stubFetch({ [REFRESH]: () => session('token-1') });
    await expect(boot()).resolves.toBe(true);
    expect(calls.map(routeOf)).toEqual([REFRESH]);
    expect(getState()).toEqual({ status: 'authenticated', user: member });
  });

  it('never lets a refresh that started during a sign-in undo it', async () => {
    const signInGate = deferred<Response>();
    const refreshGate = deferred<Response>();
    const { fetchMock } = stubFetch({
      [SIGN_IN]: () => signInGate.promise,
      [REFRESH]: () => refreshGate.promise,
    });
    const signedIn = signIn(member.email, 'right');
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    // Another tab's sign-in, say, starts a refresh with the old cookie.
    const refreshed = refresh();
    signInGate.resolve(session('token-2'));
    await signedIn;
    refreshGate.resolve(failure(401, 'Invalid or expired session'));
    await expect(refreshed).resolves.toBe(true);
    expect(getAccessToken()).toBe('token-2');
  });

  it('lets a sign-in wait for a refresh already on its way', async () => {
    const gate = deferred<Response>();
    const { calls } = stubFetch({
      [REFRESH]: () => gate.promise,
      [SIGN_IN]: () => session('token-2'),
    });
    void refresh();
    const signedIn = signIn(member.email, 'right');
    gate.resolve(failure(401, 'Invalid or expired session'));
    await signedIn;
    // A late rotation could otherwise replace the cookie the sign-in set.
    expect(calls.map(routeOf).at(-1)).toBe(SIGN_IN);
    expect(getAccessToken()).toBe('token-2');
  });
});

describe('boot', () => {
  it('settles as anonymous without asking the server when there is no session hint', async () => {
    clearSessionHint();
    const { fetchMock } = stubFetch({ [REFRESH]: () => session('token-1') });
    await expect(boot()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getState().status).toBe('anonymous');
  });

  it('refreshes only once per page load', async () => {
    const { fetchMock } = stubFetch({ [REFRESH]: () => session('token-1') });
    await boot();
    await boot();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('api middleware', () => {
  it('sends the bearer token outside /api/auth, never on the auth routes', async () => {
    const { calls } = stubFetch({ [ME]: () => ok(member), [REFRESH]: () => session('token-2') });
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });

    await api.GET('/api/users/me');
    await api.POST('/api/auth/refresh');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer token-1');
    expect(calls[1]?.headers.get('Authorization')).toBeNull();
  });

  it('refreshes once and replays the request after a 401', async () => {
    let meCalls = 0;
    const { calls } = stubFetch({
      [ME]: () => (meCalls++ === 0 ? failure(401, 'expired') : ok(member)),
      [REFRESH]: () => session('token-2'),
    });
    setSession({ accessToken: 'stale', expiresIn: 900, user: member });

    const { data, response } = await api.GET('/api/users/me');
    expect(response.status).toBe(200);
    expect(data?.data).toEqual(member);
    expect(calls.map(routeOf)).toEqual([ME, REFRESH, ME]);
    expect(calls[2]?.headers.get('Authorization')).toBe('Bearer token-2');
  });

  it('signs out when the replay is refused too, without looping', async () => {
    const { calls } = stubFetch({
      [ME]: () => failure(401, 'expired'),
      [REFRESH]: () => session('token-2'),
    });
    setSession({ accessToken: 'stale', expiresIn: 900, user: member });

    const { response } = await api.GET('/api/users/me');
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(3);
    expect(getState().status).toBe('anonymous');
  });

  it('does not replay when the refresh itself fails', async () => {
    const { calls } = stubFetch({
      [ME]: () => failure(401, 'expired'),
      [REFRESH]: () => failure(401, 'Invalid session'),
    });
    setSession({ accessToken: 'stale', expiresIn: 900, user: member });

    await api.GET('/api/users/me');
    // The request, the refresh and its one retry; no replay.
    expect(calls).toHaveLength(3);
    expect(getState().status).toBe('anonymous');
  });

  it('leaves a 401 to a request sent without a token alone', async () => {
    clearSession();
    const { calls } = stubFetch({ [ME]: () => failure(401, 'Missing access token') });
    const { response } = await api.GET('/api/users/me');
    expect(response.status).toBe(401);
    expect(calls.map(routeOf)).toEqual([ME]);
  });

  it('replays with the token another request already refreshed, without rotating again', async () => {
    let meCalls = 0;
    const { calls } = stubFetch({
      [ME]: () => {
        if (meCalls++ > 0) return ok(member);
        // Another request refreshed while this one was on its way.
        setSession({ accessToken: 'token-2', expiresIn: 900, user: member });
        return failure(401, 'expired');
      },
    });
    setSession({ accessToken: 'stale', expiresIn: 900, user: member });

    const { response } = await api.GET('/api/users/me');
    expect(response.status).toBe(200);
    expect(calls.map(routeOf)).toEqual([ME, ME]);
    expect(calls[1]?.headers.get('Authorization')).toBe('Bearer token-2');
  });

  it('never replays a request for another user than the one who sent it', async () => {
    const { calls } = stubFetch({
      [ME]: () => {
        // Another tab signed in as someone else meanwhile.
        setSession({ accessToken: 'token-2', expiresIn: 900, user: admin });
        return failure(401, 'expired');
      },
    });
    setSession({ accessToken: 'stale', expiresIn: 900, user: member });

    const { response } = await api.GET('/api/users/me');
    expect(response.status).toBe(401);
    expect(calls.map(routeOf)).toEqual([ME]);
  });
});

describe('signIn and signOut', () => {
  it('stores the session on success and leaves it alone on failure', async () => {
    stubFetch({ [SIGN_IN]: () => failure(401, 'Invalid email or password') });
    const refused = await signIn(member.email, 'wrong');
    expect(refused.ok).toBe(false);
    expect(getAccessToken()).toBeNull();

    stubFetch({ [SIGN_IN]: () => session('token-1') });
    await signIn(member.email, 'right');
    expect(getState()).toEqual({ status: 'authenticated', user: member });
  });

  it('forgets the session at once, before the server answers the logout', async () => {
    const gate = deferred<Response>();
    const { calls } = stubFetch({ [LOGOUT]: () => gate.promise });
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });

    const done = signOut();
    expect(getState()).toEqual(SIGNED_OUT);
    expect(getAccessToken()).toBeNull();
    gate.resolve(signedOut());
    await expect(done).resolves.toBe(true);
    // Delivered even if the page is closed right after.
    expect(calls[0]?.keepalive).toBe(true);
  });

  it('drops the session hint at once, before the server answers', async () => {
    const gate = deferred<Response>();
    stubFetch({ [LOGOUT]: () => gate.promise });
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });
    const done = signOut();
    // A page closed now leaves nothing for the next visit to restore.
    expect(document.cookie).not.toContain('has_session');
    gate.resolve(signedOut());
    await done;
  });

  it('says so when the server could not end the session, and retries', async () => {
    stubFetch({ [LOGOUT]: () => Promise.reject(new TypeError('Failed to fetch')) });
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });

    await expect(signOut()).resolves.toBe(false);
    expect(getState()).toEqual({ status: 'anonymous', user: null, signedOut: 'failed' });
    // The next page load must not revive the session from the cookie.
    expect(document.cookie).not.toContain('has_session');

    stubFetch({ [LOGOUT]: signedOut });
    await expect(retrySignOut()).resolves.toBe(true);
    expect(getState()).toEqual(SIGNED_OUT);
  });

  it('signs back in after a sign-out that raced a slow refresh, in that order', async () => {
    const gate = deferred<Response>();
    const { calls } = stubFetch({
      [REFRESH]: () => gate.promise,
      [LOGOUT]: signedOut,
      [SIGN_IN]: () => session('token-3'),
    });
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });

    void refresh();
    void signOut();
    const back = signIn(member.email, 'right');
    await vi.waitFor(() => {
      expect(calls.map(routeOf)).toEqual([REFRESH, LOGOUT]);
    });
    gate.resolve(session('token-2'));
    await back;
    // The sign-in went last: nothing can clear or replace its cookie.
    expect(calls.map(routeOf)).toEqual([REFRESH, LOGOUT, SIGN_IN]);
    expect(getAccessToken()).toBe('token-3');
  });

  it('holds a sign-in until a logout still on its way has landed', async () => {
    const gate = deferred<Response>();
    const { calls } = stubFetch({ [LOGOUT]: () => gate.promise, [SIGN_IN]: () => session('t') });
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });

    const out = signOut();
    const back = signIn(member.email, 'right');
    await vi.waitFor(() => {
      expect(calls.map(routeOf)).toEqual([LOGOUT]);
    });
    gate.resolve(signedOut());
    await Promise.all([out, back]);
    // Otherwise the logout's cookie clearing could land after the new cookie.
    expect(calls.map(routeOf)).toEqual([LOGOUT, SIGN_IN]);
    expect(getState().status).toBe('authenticated');
  });

  // "Retry sign-out" stays on the sign-in page while a sign-in is on its way.
  // A logout sent then carries the old cookie and answers by clearing the
  // cookies: landing after the sign-in, it would delete the new one.
  async function afterAFailedSignOut() {
    stubFetch({ [LOGOUT]: () => Promise.reject(new TypeError('Failed to fetch')) });
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });
    await expect(signOut()).resolves.toBe(false);
  }

  it('lets a sign-in on its way end the old session instead of a retried sign-out', async () => {
    await afterAFailedSignOut();
    const gate = deferred<Response>();
    const { calls } = stubFetch({ [SIGN_IN]: () => gate.promise, [LOGOUT]: signedOut });

    const back = signIn(member.email, 'right');
    const retried = retrySignOut();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.map(routeOf)).toEqual([SIGN_IN]);
    gate.resolve(session('token-2'));
    await back;
    // The sign-in ended the old session on the server (it retires the family
    // of the cookie it presents): no logout follows it.
    await expect(retried).resolves.toBe(true);
    expect(calls.map(routeOf)).toEqual([SIGN_IN]);
    expect(getState()).toEqual({ status: 'authenticated', user: member });
    expect(getAccessToken()).toBe('token-2');
  });

  it('retries the sign-out once a sign-in on its way has failed', async () => {
    await afterAFailedSignOut();
    const gate = deferred<Response>();
    const { calls } = stubFetch({ [SIGN_IN]: () => gate.promise, [LOGOUT]: signedOut });

    const back = signIn(member.email, 'wrong');
    const retried = retrySignOut();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.map(routeOf)).toEqual([SIGN_IN]);
    gate.resolve(failure(401, 'Invalid email or password'));
    await back;
    await expect(retried).resolves.toBe(true);
    expect(calls.map(routeOf)).toEqual([SIGN_IN, LOGOUT]);
    expect(getState()).toEqual(SIGNED_OUT);
  });
});

describe('other tabs', () => {
  let otherTab: BroadcastChannel;
  beforeEach(() => {
    otherTab = new BroadcastChannel('auth');
  });
  afterEach(() => {
    otherTab.close();
  });

  it('are told about sign-ins and sign-outs', async () => {
    const heard: unknown[] = [];
    otherTab.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
      heard.push(data);
    });
    stubFetch({ [SIGN_IN]: () => session('token-1'), [LOGOUT]: signedOut });
    await signIn(member.email, 'right');
    await signOut();
    await vi.waitFor(() => {
      expect(heard).toEqual(['signed-in', 'signed-out']);
    });
  });

  it('sign this tab out when one of them signs out', async () => {
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });
    otherTab.postMessage('signed-out');
    await vi.waitFor(() => {
      expect(getState()).toEqual(SIGNED_OUT);
    });
    expect(getAccessToken()).toBeNull();
  });

  it('keep an anonymous tab signed out when the sign-in it was picking up is signed out of', async () => {
    clearSession();
    const gate = deferred<Response>();
    const { calls } = stubFetch({ [REFRESH]: () => gate.promise });
    otherTab.postMessage('signed-in');
    await vi.waitFor(() => {
      expect(calls.map(routeOf)).toEqual([REFRESH]);
    });
    otherTab.postMessage('signed-out');
    // Let the message arrive before the refresh answers.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The server rotated before the logout reached it.
    gate.resolve(session('token-of-the-ended-session'));
    await expect(refresh()).resolves.toBe(false);
    expect(getAccessToken()).toBeNull();
    expect(getState().status).toBe('anonymous');
  });

  it('share a sign-in with an anonymous tab', async () => {
    clearSession();
    stubFetch({ [REFRESH]: () => session('token-1') });
    otherTab.postMessage('signed-in');
    await vi.waitFor(() => {
      expect(getState()).toEqual({ status: 'authenticated', user: member });
    });
  });
});

describe('sign-in answered with something that is not a session', () => {
  it.each([
    ['an empty envelope', () => ok(null)],
    ['another shape', () => ok({ unexpected: true })],
    ['no body at all', () => new Response(null, { status: 204 })],
  ])('is a failure for %s, and the visitor stays anonymous', async (_label, answer) => {
    clearSession();
    stubFetch({ [SIGN_IN]: answer });
    const result = await signIn(member.email, 'member-password');
    expect(result.ok).toBe(false);
    expect(getState().status).toBe('anonymous');
    expect(getAccessToken()).toBeNull();
  });
});

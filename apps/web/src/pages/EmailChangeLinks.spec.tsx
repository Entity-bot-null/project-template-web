import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boot, clearSession, getState, resetForTests, setSession } from '../auth/session';
import { member } from '../test/fixtures';
import {
  clearSessionHint,
  deferred,
  failure,
  session,
  SESSION_ID,
  setSessionHint,
  stubFetch,
} from '../test/http';
import { renderRoute } from '../test/render';

// The two pages a change of email's messages open: confirming the new
// address, and undoing the change from the previous one.

const CONFIRM = 'POST /api/auth/email-changes/confirm';
const REVERT = 'POST /api/auth/email-changes/revert';
const LOGOUT = 'POST /api/auth/logout';
const REFRESH = 'POST /api/auth/refresh';
const TOKEN = 'Ec4_b-Rv8'.padEnd(43, 'q');
const GOOD = 'violet harbour lantern 7';
const done = () => new Response(null, { status: 204 });
const pathOf = (request: Request) => new URL(request.url).pathname;

beforeEach(() => {
  resetForTests();
  clearSession();
});
afterEach(() => {
  resetForTests();
  // Set by the tests of a tab still booting: gone even when one fails.
  clearSessionHint();
});

describe('ConfirmEmailChangePage', () => {
  const LINK = `/confirm-email-change#token=${TOKEN}`;

  async function useAddress() {
    await screen.findByRole('heading', { name: 'Confirm your new address' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Use this address' }));
  }

  it('changes nothing on opening: the token leaves the address bar, the button spends it', async () => {
    const { calls } = stubFetch({ [CONFIRM]: done });
    const router = renderRoute(LINK);
    await screen.findByRole('heading', { name: 'Confirm your new address' });
    await expect.poll(() => router.state.location.hash).toBe('');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(calls).toEqual([]);

    await useAddress();
    expect(
      await screen.findByRole('heading', { name: 'Email address changed' }),
    ).toBeInTheDocument();
    await expect(calls[0]?.json()).resolves.toEqual({ token: TOKEN });
    expect(screen.getByRole('link', { name: 'Sign in with your new address' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
  });

  it('signs this browser out when it was signed in: every session of the account ended', async () => {
    const { calls } = stubFetch({ [CONFIRM]: done, [LOGOUT]: done });
    setSession({ accessToken: 'token-1', expiresIn: 900, sessionId: SESSION_ID, user: member });
    renderRoute(LINK);
    await useAddress();
    await screen.findByRole('heading', { name: 'Email address changed' });
    expect(getState().status).toBe('anonymous');
    await expect
      .poll(() => calls.map(pathOf))
      .toEqual(['/api/auth/email-changes/confirm', '/api/auth/logout']);
  });

  it.each([
    [404, 'already used, has expired, or was replaced'],
    [409, 'now used by another account'],
  ])('explains a %i, and says the address did not change', async (status, shown) => {
    stubFetch({ [CONFIRM]: () => failure(status, 'refused') });
    renderRoute(LINK);
    await useAddress();
    expect(
      await screen.findByRole('heading', { name: 'This link does not work' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(shown);
  });

  it('signs out a tab whose boot refresh is still on its way, so it never lands', async () => {
    resetForTests();
    setSessionHint();
    const refreshed = deferred<Response>();
    const { calls } = stubFetch({
      [CONFIRM]: done,
      [REFRESH]: () => refreshed.promise,
      [LOGOUT]: done,
    });
    const booting = boot();
    renderRoute(LINK);
    await useAddress();
    await screen.findByRole('heading', { name: 'Email address changed' });
    await expect.poll(() => calls.map(pathOf)).toContain('/api/auth/logout');
    refreshed.resolve(session('token-1'));
    await expect(booting).resolves.toBe(false);
    expect(getState().status).toBe('anonymous');
  });

  it('keeps the button for another try when the server fails, and explains a cut link', async () => {
    stubFetch({ [CONFIRM]: () => failure(503, 'Database unreachable') });
    renderRoute(LINK);
    await useAddress();
    expect(await screen.findByRole('alert')).toHaveTextContent('The service is unavailable');
    expect(screen.getByRole('button', { name: 'Use this address' })).toBeEnabled();
  });

  it('explains an incomplete link, sending nothing', async () => {
    const { fetchMock } = stubFetch({});
    renderRoute('/confirm-email-change#token=short');
    expect(await screen.findByRole('alert')).toHaveTextContent('This link is incomplete.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('RevertEmailChangePage', () => {
  const LINK = `/revert-email-change#token=${TOKEN}`;

  async function undo(password: string) {
    await screen.findByRole('heading', { name: 'Undo the change of address' });
    const user = userEvent.setup();
    if (password) await user.type(screen.getByLabelText('New password'), password);
    await user.click(screen.getByRole('button', { name: 'Undo the change' }));
  }

  it('puts the address back with a new password, then signs this browser out', async () => {
    const { calls } = stubFetch({ [REVERT]: done, [LOGOUT]: done });
    setSession({ accessToken: 'token-1', expiresIn: 900, sessionId: SESSION_ID, user: member });
    const router = renderRoute(LINK);
    await expect.poll(() => router.state.location.hash).toBe('');
    await undo(GOOD);
    expect(
      await screen.findByRole('heading', { name: 'Your address is back' }),
    ).toBeInTheDocument();
    await expect(calls[0]?.json()).resolves.toEqual({ token: TOKEN, password: GOOD });
    expect(getState().status).toBe('anonymous');
  });

  it('signs out a tab whose boot refresh is still on its way, so it never lands', async () => {
    resetForTests();
    setSessionHint();
    const refreshed = deferred<Response>();
    const { calls } = stubFetch({
      [REVERT]: done,
      [REFRESH]: () => refreshed.promise,
      [LOGOUT]: done,
    });
    const booting = boot();
    renderRoute(LINK);
    await undo(GOOD);
    await screen.findByRole('heading', { name: 'Your address is back' });
    await expect.poll(() => calls.map(pathOf)).toContain('/api/auth/logout');
    refreshed.resolve(session('token-1'));
    await expect(booting).resolves.toBe(false);
    expect(getState().status).toBe('anonymous');
  });

  it('checks the password first, and asks for another when the API refuses it, keeping the link', async () => {
    let attempts = 0;
    const { calls } = stubFetch({
      [REVERT]: () => (attempts++ === 0 ? failure(400, 'password: too common') : done()),
    });
    renderRoute(LINK);
    await undo('short');
    expect(screen.getByText('Use at least 15 characters (5 now).')).toBeInTheDocument();
    expect(calls).toEqual([]);
    await userEvent.setup().clear(screen.getByLabelText('New password'));
    await undo('correct horse battery staple');
    expect(await screen.findByText(/Choose another password/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Undo the change' }));
    expect(
      await screen.findByRole('heading', { name: 'Your address is back' }),
    ).toBeInTheDocument();
  });

  it.each([
    [404, 'already used or has expired'],
    [409, 'now belongs to another account'],
  ])('explains a %i', async (status, shown) => {
    stubFetch({ [REVERT]: () => failure(status, 'refused') });
    renderRoute(LINK);
    await undo(GOOD);
    expect(
      await screen.findByRole('heading', { name: 'This link does not work' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(shown);
  });

  it('keeps the form when the server fails, and explains a cut link', async () => {
    stubFetch({ [REVERT]: () => failure(503, 'Database unreachable') });
    renderRoute(LINK);
    await undo(GOOD);
    expect(await screen.findByRole('alert')).toHaveTextContent('The service is unavailable');
    expect(screen.getByRole('button', { name: 'Undo the change' })).toBeEnabled();
  });

  it('explains an incomplete link, sending nothing', async () => {
    const { fetchMock } = stubFetch({});
    renderRoute('/revert-email-change');
    expect(await screen.findByRole('alert')).toHaveTextContent('This link is incomplete.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

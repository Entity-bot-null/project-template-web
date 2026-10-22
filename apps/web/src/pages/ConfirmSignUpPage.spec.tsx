import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSession, getAccessToken, getState, resetForTests } from '../auth/session';
import { member } from '../test/fixtures';
import { deferred, failure, session, stubFetch } from '../test/http';
import { renderRoute } from '../test/render';

const CONFIRM = 'POST /api/auth/sign-ups/confirm';
const TOKEN = 'Hq7_a-Kp2'.padEnd(43, 'z');
const LINK = `/confirm-sign-up#token=${TOKEN}`;
const PASSWORD = 'violet harbour lantern 7';

beforeEach(() => {
  resetForTests();
  clearSession();
});
afterEach(() => {
  resetForTests();
});

async function confirm(password: string) {
  await screen.findByRole('heading', { name: 'Confirm your account' });
  const user = userEvent.setup();
  if (password) await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Confirm my account' }));
}

describe('ConfirmSignUpPage', () => {
  it('takes the token out of the address bar and the history as soon as the page opens', async () => {
    stubFetch({});
    const router = renderRoute(LINK);
    await screen.findByRole('heading', { name: 'Confirm your account' });
    await expect.poll(() => router.state.location.hash).toBe('');
    expect(router.state.location.pathname).toBe('/confirm-sign-up');
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('creates the account with the token and the password, and carries on signed in', async () => {
    const { calls } = stubFetch({ [CONFIRM]: () => session('token-new', member) });
    const router = renderRoute(LINK);
    await confirm(PASSWORD);

    expect(
      await screen.findByRole('heading', { name: `Welcome, ${member.name}` }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    await expect(calls[0]?.json()).resolves.toEqual({ token: TOKEN, password: PASSWORD });
    expect(getAccessToken()).toBe('token-new');
    expect(getState()).toEqual({ status: 'authenticated', user: member });
  });

  it('says the account is ready when another tab signed out while it was being created', async () => {
    const answer = deferred<Response>();
    stubFetch({
      [CONFIRM]: () => answer.promise,
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });
    renderRoute(LINK);
    await confirm(PASSWORD);
    const otherTab = new BroadcastChannel('auth');
    otherTab.postMessage('signed-out');
    otherTab.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    answer.resolve(session('token-new', member));

    expect(
      await screen.findByRole('heading', { name: 'Your account is ready' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(getAccessToken()).toBeNull();
  });

  it('asks for a password before sending anything', async () => {
    const { fetchMock } = stubFetch({});
    renderRoute(LINK);
    await confirm('');
    expect(screen.getByText('Enter the password you chose when signing up.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says when the password is not the one chosen, keeping the form', async () => {
    stubFetch({ [CONFIRM]: () => failure(401, 'This is not the password chosen at sign-up') });
    renderRoute(LINK);
    await confirm('not the password');
    expect(
      await screen.findByText(/This is not the password you chose when signing up\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm my account' })).toBeEnabled();
    expect(getState().status).toBe('anonymous');
  });

  it('says a used, expired or replaced link does not work, and offers to sign up again', async () => {
    stubFetch({ [CONFIRM]: () => failure(404, 'This link is invalid or has expired') });
    renderRoute(LINK);
    await confirm(PASSWORD);
    expect(
      await screen.findByRole('heading', { name: 'This link does not work' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('replaced by a newer sign-up');
    expect(screen.getByRole('link', { name: 'Sign up again' })).toHaveAttribute('href', '/sign-up');
  });

  it('sends to sign-in when the address got an account meanwhile', async () => {
    stubFetch({ [CONFIRM]: () => failure(409, 'An account with this address exists') });
    renderRoute(LINK);
    await confirm(PASSWORD);
    expect(
      await screen.findByRole('heading', { name: 'You already have an account' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  });

  it.each([
    [403, 'Sign-up is closed', 'Sign-up is closed here.'],
    [503, 'Database unreachable', 'The service is unavailable'],
  ])('explains a %i, keeping the form', async (status, message, shown) => {
    stubFetch({ [CONFIRM]: () => failure(status, message) });
    renderRoute(LINK);
    await confirm(PASSWORD);
    expect(await screen.findByRole('alert')).toHaveTextContent(shown);
    expect(screen.getByRole('button', { name: 'Confirm my account' })).toBeEnabled();
  });

  it('explains an incomplete link, sending nothing', async () => {
    const { fetchMock } = stubFetch({});
    renderRoute(`/confirm-sign-up#token=${TOKEN.slice(0, 10)}`);
    expect(
      await screen.findByRole('heading', { name: 'This link does not work' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This link is incomplete.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

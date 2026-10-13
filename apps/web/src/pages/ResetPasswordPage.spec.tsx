import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSession, getState, resetForTests, setSession } from '../auth/session';
import { member } from '../test/fixtures';
import { failure, stubFetch } from '../test/http';
import { renderRoute } from '../test/render';

const CONFIRM = 'POST /api/auth/password-resets/confirm';
const TOKEN = 'Zq3_x-Lw9'.padEnd(43, 'k');
const LINK = `/reset-password#token=${TOKEN}`;
const GOOD = 'violet harbour lantern 7';
const done = () => new Response(null, { status: 204 });

beforeEach(() => {
  resetForTests();
  clearSession();
});
afterEach(() => {
  resetForTests();
});

async function choose(password: string) {
  await screen.findByRole('heading', { name: 'Choose a new password' });
  const user = userEvent.setup();
  if (password) await user.type(screen.getByLabelText('New password'), password);
  await user.click(screen.getByRole('button', { name: 'Save the new password' }));
}

describe('ResetPasswordPage', () => {
  it('takes the token out of the address bar and the history as soon as the page opens', async () => {
    stubFetch({});
    const router = renderRoute(LINK);
    await screen.findByRole('heading', { name: 'Choose a new password' });
    // Replaced by an effect right after the first render: the navigation that
    // follows it lands a moment later.
    await expect.poll(() => router.state.location.hash).toBe('');
    expect(router.state.location.pathname).toBe('/reset-password');
    // Replaced, not pushed: the back button does not bring it back.
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('sets the new password with the token, then forgets the token', async () => {
    const { calls } = stubFetch({ [CONFIRM]: done });
    renderRoute(LINK);
    await choose(GOOD);

    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    await expect(calls[0]?.json()).resolves.toEqual({ token: TOKEN, password: GOOD });
    expect(screen.queryByLabelText('New password')).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in with your new password' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
  });

  it('checks the password before spending the link', async () => {
    const { fetchMock } = stubFetch({});
    renderRoute(LINK);
    await choose('too short');
    expect(screen.getByText('Use at least 15 characters (9 now).')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for another password when the API refuses it, keeping the link', async () => {
    let attempts = 0;
    stubFetch({
      [CONFIRM]: () => (attempts++ === 0 ? failure(400, 'password: too common') : done()),
    });
    renderRoute(LINK);
    await choose('correct horse battery staple');
    expect(
      await screen.findByText(
        'Choose another password: this one is among the most used, or too easy to guess.',
      ),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save the new password' }));
    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
  });

  it('says a used, expired or replaced link does not work, and offers a new one', async () => {
    stubFetch({ [CONFIRM]: () => failure(404, 'This link is invalid or has expired') });
    renderRoute(LINK);
    await choose(GOOD);
    expect(
      await screen.findByRole('heading', { name: 'This link does not work' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('already used, has expired');
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('keeps the form for another try when the server fails', async () => {
    stubFetch({ [CONFIRM]: () => failure(503, 'Database unreachable') });
    renderRoute(LINK);
    await choose(GOOD);
    expect(await screen.findByRole('alert')).toHaveTextContent('The service is unavailable');
    expect(screen.getByRole('button', { name: 'Save the new password' })).toBeEnabled();
  });

  it.each([
    ['without a token', '/reset-password'],
    ['with a cut token', `/reset-password#token=${TOKEN.slice(0, 20)}`],
    ['with something else after #', '/reset-password#password=x'],
  ])('explains a link %s, sending nothing', async (_case, path) => {
    const { fetchMock } = stubFetch({});
    renderRoute(path);
    expect(
      await screen.findByRole('heading', { name: 'This link does not work' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This link is incomplete.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs this browser out when it was signed in: the account sessions ended', async () => {
    const { calls } = stubFetch({
      [CONFIRM]: done,
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });
    renderRoute(LINK);
    await choose(GOOD);
    await screen.findByRole('heading', { name: 'Password changed' });
    expect(getState().status).toBe('anonymous');
    await expect
      .poll(() => calls.map((request) => new URL(request.url).pathname))
      .toEqual(['/api/auth/password-resets/confirm', '/api/auth/logout']);
  });
});

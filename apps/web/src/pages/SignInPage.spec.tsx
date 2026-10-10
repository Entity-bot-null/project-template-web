import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSession, resetForTests, setSession } from '../auth/session';
import { member } from '../test/fixtures';
import { failure, ok, session, stubFetch } from '../test/http';
import { renderRoute } from '../test/render';

const SIGN_IN = 'POST /api/auth/sign-in';

beforeEach(() => {
  resetForTests();
  clearSession();
});
afterEach(() => {
  resetForTests();
});

async function submit(email: string, password: string) {
  const user = userEvent.setup();
  if (email) await user.type(screen.getByLabelText('Email'), email);
  if (password) await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('SignInPage', () => {
  it('checks the fields before calling the API', async () => {
    const { fetchMock } = stubFetch({});
    renderRoute('/sign-in');
    await submit('not-an-email', '');
    expect(screen.getByText('Enter a valid email.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs in and continues where the guard stopped the user', async () => {
    const { calls } = stubFetch({
      [SIGN_IN]: () => session('token-1', member),
      'GET /api/users': () => ok({ items: [], total: 0 }),
    });
    const router = renderRoute('/');
    await router.navigate('/sign-in', { state: { from: '/admin/users' } });
    await submit(member.email, 'member-password');

    await screen.findByRole('heading', { name: `Welcome, ${member.name}` });
    // A member is then turned away from the admin area by its own guard.
    expect(router.state.location.pathname).toBe('/');
    await expect(calls[0]?.json()).resolves.toEqual({
      email: member.email,
      password: 'member-password',
    });
  });

  it('shows one message for wrong credentials', async () => {
    stubFetch({ [SIGN_IN]: () => failure(401, 'Invalid email or password') });
    renderRoute('/sign-in');
    await submit(member.email, 'wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('offers to retry a sign-out the server did not confirm', async () => {
    let attempts = 0;
    stubFetch({
      'POST /api/auth/logout': () =>
        attempts++ === 0 ? failure(503, 'unavailable') : new Response(null, { status: 204 }),
    });
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });
    renderRoute('/');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be reached');
    await user.click(screen.getByRole('button', { name: 'Retry sign-out' }));
    await expect.poll(() => screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('tells the user how long to wait when rate limited', async () => {
    stubFetch({ [SIGN_IN]: () => failure(429, 'Too many', { 'Retry-After': '42' }) });
    renderRoute('/sign-in');
    await submit(member.email, 'whatever');
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait 42 seconds');
  });
});

describe('a sign-in answer that is not a session', () => {
  it('gives the button back and explains the failure', async () => {
    stubFetch({ [SIGN_IN]: () => ok(null) });
    renderRoute('/sign-in');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), member.email);
    await user.type(screen.getByLabelText('Password'), 'member-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });
});

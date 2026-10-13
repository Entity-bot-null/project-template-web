import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetCapabilitiesForTests } from '../auth/capabilities';
import { clearSession, resetForTests, setSession } from '../auth/session';
import { member } from '../test/fixtures';
import { failure, ok, session, stubFetch } from '../test/http';
import { renderRoute } from '../test/render';

const SIGN_IN = 'POST /api/auth/sign-in';
const CAPABILITIES = 'GET /api/auth/capabilities';
const routeOf = (request: Request) => `${request.method} ${new URL(request.url).pathname}`;
const offers =
  (passwordReset: boolean, signUp = false) =>
  () =>
    ok({ passwordReset, signUp });

beforeEach(() => {
  resetForTests();
  resetCapabilitiesForTests();
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
    const { calls } = stubFetch({ [CAPABILITIES]: offers(false) });
    renderRoute('/sign-in');
    await submit('not-an-email', '');
    expect(screen.getByText('Enter a valid email.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    // What the deployment offers, asked as the page opens; no sign-in.
    expect(calls.map(routeOf)).toEqual([CAPABILITIES]);
  });

  it('signs in and continues where the guard stopped the user', async () => {
    const { calls } = stubFetch({
      [CAPABILITIES]: offers(false),
      [SIGN_IN]: () => session('token-1', member),
      'GET /api/users': () => ok({ items: [], total: 0 }),
    });
    const router = renderRoute('/');
    await router.navigate('/sign-in', { state: { from: '/admin/users' } });
    await submit(member.email, 'member-password');

    await screen.findByRole('heading', { name: `Welcome, ${member.name}` });
    // A member is then turned away from the admin area by its own guard.
    expect(router.state.location.pathname).toBe('/');
    await expect(calls.find((call) => routeOf(call) === SIGN_IN)?.json()).resolves.toEqual({
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

describe('the way back into an account', () => {
  it('links to password recovery where the deployment offers it', async () => {
    stubFetch({ [CAPABILITIES]: offers(true) });
    renderRoute('/sign-in');
    await userEvent
      .setup()
      .click(await screen.findByRole('link', { name: 'Forgot your password?' }));
    expect(
      await screen.findByRole('heading', { name: 'Forgot your password?' }),
    ).toBeInTheDocument();
  });

  it('links to sign-up where it is open', async () => {
    stubFetch({ [CAPABILITIES]: offers(true, true) });
    renderRoute('/sign-in');
    await userEvent.setup().click(await screen.findByRole('link', { name: 'Create an account' }));
    expect(await screen.findByRole('heading', { name: 'Create an account' })).toBeInTheDocument();
  });

  it('shows no link where email is off, or while that cannot be known', async () => {
    const { calls } = stubFetch({ [CAPABILITIES]: offers(false) });
    renderRoute('/sign-in');
    await expect.poll(() => calls.length).toBe(1);
    expect(screen.queryByRole('link', { name: 'Forgot your password?' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Create an account' })).toBeNull();
  });

  it('asks again on the next visit after a failed answer, never caching it', async () => {
    let attempts = 0;
    stubFetch({
      [CAPABILITIES]: () => (attempts++ === 0 ? failure(503, 'unavailable') : offers(true)()),
    });
    const router = renderRoute('/sign-in');
    await expect.poll(() => attempts).toBe(1);
    expect(screen.queryByRole('link', { name: 'Forgot your password?' })).toBeNull();
    // Visit again until the failure has settled: a page that opens while the
    // first answer is still on its way shares it, one that opens after asks
    // again.
    await expect
      .poll(async () => {
        await act(() => router.navigate('/no/such/page'));
        await act(() => router.navigate('/sign-in'));
        return attempts;
      })
      .toBe(2);
    expect(await screen.findByRole('link', { name: 'Forgot your password?' })).toBeInTheDocument();
    // Remembered once it worked: no third request.
    await act(() => router.navigate('/no/such/page'));
    await act(() => router.navigate('/sign-in'));
    await screen.findByRole('link', { name: 'Forgot your password?' });
    expect(attempts).toBe(2);
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

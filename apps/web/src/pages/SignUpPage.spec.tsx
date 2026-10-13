import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSession, resetForTests, setSession } from '../auth/session';
import { member } from '../test/fixtures';
import { failure, json, stubFetch } from '../test/http';
import { renderRoute } from '../test/render';

const SIGN_UP = 'POST /api/auth/sign-ups';
const GOOD = 'violet harbour lantern 7';
const accepted = () => json(202, { data: null, message: 'Operation successful' });

beforeEach(() => {
  resetForTests();
  clearSession();
});
afterEach(() => {
  resetForTests();
});

async function signUp({ name = 'Ada Lovelace', email = 'ada@example.com', password = GOOD } = {}) {
  await screen.findByRole('heading', { name: 'Create an account' });
  const user = userEvent.setup();
  if (name) await user.type(screen.getByLabelText('Name'), name);
  if (email) await user.type(screen.getByLabelText('Email'), email);
  if (password) await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Create my account' }));
  return user;
}

describe('SignUpPage', () => {
  it('checks every field before calling the API', async () => {
    const { fetchMock } = stubFetch({});
    renderRoute('/sign-up');
    await signUp({ name: '', email: 'not-an-email', password: 'short' });
    expect(screen.getByText('Enter your name.')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid email.')).toBeInTheDocument();
    expect(screen.getByText('Use at least 15 characters (5 now).')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a password made of the name or the email', async () => {
    const { fetchMock } = stubFetch({});
    renderRoute('/sign-up');
    await signUp({ password: 'lovelace and her engines' });
    expect(
      screen.getByText('Leave your email address and your name out of your password.'),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the sign-up and says the same whether or not the address has an account', async () => {
    const { calls } = stubFetch({ [SIGN_UP]: accepted });
    renderRoute('/sign-up');
    const user = await signUp({ name: '  Ada Lovelace ', email: ' ada@example.com ' });

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'A message is on its way to ada@example.com',
    );
    await expect(calls[0]?.json()).resolves.toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: GOOD,
    });
    await user.click(screen.getByRole('button', { name: 'try again' }));
    // The password is not kept once sent.
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('shows a refused address next to the email field, not as a password problem', async () => {
    stubFetch({ [SIGN_UP]: () => failure(400, 'email: Invalid email address') });
    renderRoute('/sign-up');
    await signUp({ email: 'a..b@example.com' });
    expect(await screen.findByText('Enter a valid email.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveFocus();
    expect(screen.queryByText(/Choose another password/)).toBeNull();
  });

  it.each([
    [400, 'password: too common', 'Choose another password'],
    [400, 'name: Too long', 'Enter your name (up to 100 characters).'],
    [403, 'Sign-up is closed', 'Sign-up is closed here.'],
    [429, 'Too many', 'Too many attempts.'],
  ])('explains a %i', async (status, message, shown) => {
    stubFetch({ [SIGN_UP]: () => failure(status, message) });
    renderRoute('/sign-up');
    await signUp();
    expect(await screen.findByText(shown, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create my account' })).toBeEnabled();
  });

  it('is for signed-out visitors only', async () => {
    stubFetch({});
    setSession({ accessToken: 'token-1', expiresIn: 900, user: member });
    const router = renderRoute('/sign-up');
    await screen.findByRole('heading', { name: `Welcome, ${member.name}` });
    expect(router.state.location.pathname).toBe('/');
  });
});

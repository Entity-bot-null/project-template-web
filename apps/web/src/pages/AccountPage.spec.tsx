import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetCapabilitiesForTests } from '../auth/capabilities';
import { getAccessToken, resetForTests, setSession } from '../auth/session';
import { member } from '../test/fixtures';
import { failure, json, ok, session, stubFetch } from '../test/http';
import { renderRoute } from '../test/render';

const CHANGE = 'POST /api/account/password';
const CHANGE_EMAIL = 'POST /api/account/email';
const CAPABILITIES = 'GET /api/auth/capabilities';
const routeOf = (request: Request) => `${request.method} ${new URL(request.url).pathname}`;
const offers = (emailChange: boolean) => () =>
  ok({ passwordReset: emailChange, signUp: false, emailChange });
const CURRENT = 'member-password';
const GOOD = 'violet harbour lantern 7';

beforeEach(() => {
  resetForTests();
  resetCapabilitiesForTests();
  setSession({ accessToken: 'token-1', expiresIn: 900, user: member });
});
afterEach(() => {
  resetForTests();
});

async function change(current: string, next: string) {
  await screen.findByRole('heading', { name: 'Your account' });
  const user = userEvent.setup();
  if (current) await user.type(screen.getByLabelText('Current password'), current);
  if (next) await user.type(screen.getByLabelText('New password'), next);
  await user.click(screen.getByRole('button', { name: 'Change password' }));
  return user;
}

describe('AccountPage', () => {
  it('is linked from the layout and shows who is signed in', async () => {
    stubFetch({});
    renderRoute('/');
    await userEvent.setup().click(await screen.findByRole('link', { name: 'Account' }));
    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(screen.getByText(member.name)).toBeInTheDocument();
    expect(screen.getAllByText(member.email).length).toBeGreaterThan(0);
  });

  it('checks both fields before calling the API', async () => {
    const { calls } = stubFetch({ [CAPABILITIES]: offers(false) });
    renderRoute('/account');
    await change('', 'short');
    expect(screen.getByText('Enter your current password.')).toBeInTheDocument();
    expect(screen.getByText('Use at least 15 characters (5 now).')).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toHaveAttribute('aria-invalid', 'true');
    // Only what the deployment offers was asked; no change was sent.
    expect(calls.map(routeOf)).toEqual([CAPABILITIES]);
  });

  it('refuses a new password made of the account email or name', async () => {
    const { calls } = stubFetch({ [CAPABILITIES]: offers(false) });
    renderRoute('/account');
    await change(CURRENT, 'member for ever and ever');
    expect(
      screen.getByText('Leave your email address and your name out of your password.'),
    ).toBeInTheDocument();
    // Only what the deployment offers was asked; no change was sent.
    expect(calls.map(routeOf)).toEqual([CAPABILITIES]);
  });

  it('changes the password and carries on in the new session the API answers with', async () => {
    const { calls } = stubFetch({
      [CAPABILITIES]: offers(false),
      [CHANGE]: () => session('token-2'),
    });
    renderRoute('/account');
    await change(CURRENT, GOOD);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Every other session of your account was signed out.',
    );
    const sent = calls.find((call) => routeOf(call) === CHANGE);
    await expect(sent?.json()).resolves.toEqual({
      currentPassword: CURRENT,
      newPassword: GOOD,
    });
    expect(sent?.headers.get('Authorization')).toBe('Bearer token-1');
    expect(getAccessToken()).toBe('token-2');
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
  });

  it('says when the current password is wrong', async () => {
    stubFetch({ [CHANGE]: () => failure(403, 'The current password is wrong') });
    renderRoute('/account');
    await change('not-the-password', GOOD);
    expect(await screen.findByText('Your current password is not correct.')).toBeInTheDocument();
    expect(getAccessToken()).toBe('token-1');
  });

  it('asks for another new password when the API refuses it', async () => {
    stubFetch({ [CHANGE]: () => failure(400, 'newPassword: too common') });
    renderRoute('/account');
    await change(CURRENT, 'correct horse battery staple');
    expect(
      await screen.findByText(
        'Choose another password: this one is among the most used, or too easy to guess.',
      ),
    ).toBeInTheDocument();
  });

  it.each([
    [409, 'The password changed meanwhile', 'changed in another session meanwhile'],
    [503, 'Database unreachable', 'The service is unavailable'],
  ])('explains a %i', async (status, message, shown) => {
    stubFetch({ [CHANGE]: () => failure(status, message) });
    renderRoute('/account');
    await change(CURRENT, GOOD);
    expect(await screen.findByRole('alert')).toHaveTextContent(shown);
    expect(screen.getByRole('button', { name: 'Change password' })).toBeEnabled();
  });
});

describe('changing the email', () => {
  const form = () => screen.findByRole('form', { name: 'Change your email' });

  async function ask(newEmail: string, password: string) {
    const scope = within(await form());
    const user = userEvent.setup();
    if (newEmail) await user.type(scope.getByLabelText('New email'), newEmail);
    if (password) await user.type(scope.getByLabelText('Current password'), password);
    await user.click(scope.getByRole('button', { name: 'Change email' }));
    return scope;
  }

  it('is offered only where email works', async () => {
    const { calls } = stubFetch({ [CAPABILITIES]: offers(false) });
    renderRoute('/account');
    await screen.findByRole('heading', { name: 'Your account' });
    await expect.poll(() => calls.length).toBe(1);
    expect(screen.queryByRole('form', { name: 'Change your email' })).toBeNull();
  });

  it('checks the fields before calling the API, the current address included', async () => {
    const { calls } = stubFetch({ [CAPABILITIES]: offers(true) });
    renderRoute('/account');
    const scope = await ask(member.email.toUpperCase(), '');
    expect(scope.getByText('This is already your address.')).toBeInTheDocument();
    expect(scope.getByText('Enter your current password.')).toBeInTheDocument();
    expect(calls.map(routeOf)).toEqual([CAPABILITIES]);
  });

  it('sends the new address with the current password, and says nothing changes yet', async () => {
    const { calls } = stubFetch({
      [CAPABILITIES]: offers(true),
      [CHANGE_EMAIL]: () => json(202, { data: null, message: 'Operation successful' }),
    });
    renderRoute('/account');
    const scope = await ask(' new@example.com ', CURRENT);
    expect(await scope.findByRole('status')).toHaveTextContent(
      'A link is on its way to new@example.com',
    );
    const sent = calls.find((call) => routeOf(call) === CHANGE_EMAIL);
    await expect(sent?.json()).resolves.toEqual({
      newEmail: 'new@example.com',
      currentPassword: CURRENT,
    });
    expect(sent?.headers.get('Authorization')).toBe('Bearer token-1');
    expect(scope.getByLabelText('Current password')).toHaveValue('');
  });

  it.each([
    [403, 'The current password is wrong', 'Your current password is not correct.'],
    [400, 'newEmail: This is already the address', 'This is already your address.'],
    [400, 'newEmail: Invalid email address', 'Enter a valid email.'],
    [503, 'Not available', 'Changing the address is not available here.'],
    [429, 'Too many', 'Too many attempts.'],
  ])('explains a %i', async (status, message, shown) => {
    stubFetch({ [CAPABILITIES]: offers(true), [CHANGE_EMAIL]: () => failure(status, message) });
    renderRoute('/account');
    const scope = await ask('new@example.com', CURRENT);
    expect(await scope.findByText(shown, { exact: false })).toBeInTheDocument();
    expect(scope.getByRole('button', { name: 'Change email' })).toBeEnabled();
  });
});

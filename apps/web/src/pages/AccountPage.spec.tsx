import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAccessToken, resetForTests, setSession } from '../auth/session';
import { member } from '../test/fixtures';
import { failure, session, stubFetch } from '../test/http';
import { renderRoute } from '../test/render';

const CHANGE = 'POST /api/account/password';
const CURRENT = 'member-password';
const GOOD = 'violet harbour lantern 7';

beforeEach(() => {
  resetForTests();
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
    const { fetchMock } = stubFetch({});
    renderRoute('/account');
    await change('', 'short');
    expect(screen.getByText('Enter your current password.')).toBeInTheDocument();
    expect(screen.getByText('Use at least 15 characters (5 now).')).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a new password made of the account email or name', async () => {
    const { fetchMock } = stubFetch({});
    renderRoute('/account');
    await change(CURRENT, 'member for ever and ever');
    expect(
      screen.getByText('Leave your email address and your name out of your password.'),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('changes the password and carries on in the new session the API answers with', async () => {
    const { calls } = stubFetch({ [CHANGE]: () => session('token-2') });
    renderRoute('/account');
    await change(CURRENT, GOOD);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Every other session of your account was signed out.',
    );
    await expect(calls[0]?.json()).resolves.toEqual({
      currentPassword: CURRENT,
      newPassword: GOOD,
    });
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer token-1');
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

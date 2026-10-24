import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSession, resetForTests, setSession } from '../auth/session';
import { member } from '../test/fixtures';
import { failure, SESSION_ID, stubFetch } from '../test/http';
import { renderRoute } from '../test/render';

const REQUEST = 'POST /api/auth/password-resets';
const accepted = () => new Response(null, { status: 204 });

beforeEach(() => {
  resetForTests();
  clearSession();
});
afterEach(() => {
  resetForTests();
});

async function ask(email: string) {
  await screen.findByRole('heading', { name: 'Forgot your password?' });
  const user = userEvent.setup();
  if (email) await user.type(screen.getByLabelText('Email'), email);
  await user.click(screen.getByRole('button', { name: 'Send the link' }));
  return user;
}

describe('ForgotPasswordPage', () => {
  it('checks the address before calling the API', async () => {
    const { fetchMock } = stubFetch({});
    renderRoute('/forgot-password');
    await ask('not-an-email');
    expect(screen.getByText('Enter a valid email.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for a link and says the same whether or not the account exists', async () => {
    const { calls } = stubFetch({ [REQUEST]: accepted });
    renderRoute('/forgot-password');
    const user = await ask('  ada@example.com ');

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'If an account exists for ada@example.com, a message with a link',
    );
    await expect(calls[0]?.json()).resolves.toEqual({ email: 'ada@example.com' });

    // Asking again goes back to the form.
    await user.click(screen.getByRole('button', { name: 'ask again' }));
    expect(screen.getByRole('button', { name: 'Send the link' })).toBeEnabled();
  });

  it('says when this deployment cannot send the link', async () => {
    stubFetch({ [REQUEST]: () => failure(503, 'Email is not configured') });
    renderRoute('/forgot-password');
    await ask('ada@example.com');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Password recovery is not available here.',
    );
  });

  it('tells how long to wait when rate limited', async () => {
    stubFetch({ [REQUEST]: () => failure(429, 'Too many', { 'Retry-After': '42' }) });
    renderRoute('/forgot-password');
    await ask('ada@example.com');
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait 42 seconds');
    expect(screen.getByRole('button', { name: 'Send the link' })).toBeEnabled();
  });

  it('is for signed-out visitors only', async () => {
    stubFetch({});
    setSession({ accessToken: 'token-1', expiresIn: 900, sessionId: SESSION_ID, user: member });
    const router = renderRoute('/forgot-password');
    await screen.findByRole('heading', { name: `Welcome, ${member.name}` });
    expect(router.state.location.pathname).toBe('/');
  });
});

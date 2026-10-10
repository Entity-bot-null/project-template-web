import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { admin, member } from '../test/fixtures';
import { ok, stubFetch } from '../test/http';
import { renderRoute } from '../test/render';
import { returnPath } from './return-path';
import { clearSession, resetForTests, setSession, signOut } from './session';
import type { AuthUser } from './types';

const signedInAs = (user: AuthUser) => {
  setSession({ accessToken: 't', expiresIn: 900, user });
};

beforeEach(() => {
  resetForTests();
});
afterEach(() => {
  resetForTests();
});

describe('route guards', () => {
  it('shows a loading screen until the boot refresh settles', () => {
    renderRoute('/');
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });

  it('sends anonymous visitors to sign-in and remembers where they were going', () => {
    clearSession();
    const router = renderRoute('/admin/users?page=2');
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(router.state.location.state).toEqual({ from: '/admin/users?page=2' });
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('forgets the last page after a sign-out: the next user starts at home', async () => {
    stubFetch({
      'GET /api/users': () => ok({ items: [], total: 0 }),
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });
    signedInAs(admin);
    const router = renderRoute('/admin/users');
    await act(() => signOut());
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(returnPath(router.state.location.state)).toBe('/');
  });

  it('keeps members out of the admin area', () => {
    signedInAs(member);
    expect(renderRoute('/admin/users').state.location.pathname).toBe('/');
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('lets admins into the admin area', async () => {
    stubFetch({ 'GET /api/users': () => ok({ items: [], total: 0 }) });
    signedInAs(admin);
    expect(renderRoute('/admin/users').state.location.pathname).toBe('/admin/users');
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
  });

  it('sends a signed-in user away from sign-in', () => {
    signedInAs(member);
    expect(renderRoute('/sign-in').state.location.pathname).toBe('/');
  });

  it('shows a not-found page for unknown paths', () => {
    clearSession();
    renderRoute('/no/such/page');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

describe('returnPath', () => {
  it('accepts paths inside the app only', () => {
    expect(returnPath({ from: '/admin/users?x=1' })).toBe('/admin/users?x=1');
    expect(returnPath({ from: '//evil.example.net' })).toBe('/');
    expect(returnPath({ from: 'https://evil.example.net' })).toBe('/');
    expect(returnPath(null)).toBe('/');
    expect(returnPath({ from: 42 })).toBe('/');
  });
});

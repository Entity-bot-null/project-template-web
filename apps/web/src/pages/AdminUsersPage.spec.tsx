import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getState, resetForTests, setSession } from '../auth/session';
import { admin, member } from '../test/fixtures';
import { failure, json, ok, stubFetch } from '../test/http';
import { renderRoute } from '../test/render';

const LIST = 'GET /api/users';
const row = (user: typeof member) => ({ ...user, createdAt: '2026-01-01T00:00:00.000Z' });

beforeEach(() => {
  resetForTests();
  setSession({ accessToken: 'admin-token', expiresIn: 900, user: admin });
});
afterEach(() => {
  resetForTests();
});

describe('AdminUsersPage', () => {
  it('lists the users the API returns', async () => {
    const { calls } = stubFetch({
      [LIST]: () => ok({ items: [row(admin), row(member)], total: 2 }),
    });
    renderRoute('/admin/users');

    expect(await screen.findByRole('cell', { name: member.email })).toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 2.')).toBeInTheDocument();
    expect(new URL(calls[0]?.url ?? '').searchParams.get('limit')).toBe('50');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer admin-token');
  });

  it('explains a failure and retries on demand', async () => {
    let attempt = 0;
    stubFetch({
      [LIST]: () =>
        attempt++ === 0
          ? failure(503, 'Database unreachable')
          : ok({ items: [row(member)], total: 1 }),
    });
    renderRoute('/admin/users');

    expect(await screen.findByRole('alert')).toHaveTextContent('The service is unavailable');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('cell', { name: member.email })).toBeInTheDocument();
  });

  it('offers a retry, never the crash page, when a success answer is not the envelope', async () => {
    let attempt = 0;
    stubFetch({
      // Something between the browser and the API answered 200 for it.
      [LIST]: () => (attempt++ === 0 ? json(200, {}) : ok({ items: [row(member)], total: 1 })),
    });
    renderRoute('/admin/users');

    expect(await screen.findByRole('alert')).toHaveTextContent('The service is unavailable');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('cell', { name: member.email })).toBeInTheDocument();
  });
});

describe('the session switches to another user', () => {
  it('drops what was loaded for the previous user and loads again with the new token', async () => {
    const otherAdmin = {
      ...admin,
      id: '0190b6a1-0000-7000-8000-000000000003',
      email: 'other-admin@example.com',
    };
    setSession({ accessToken: 'token-a', expiresIn: 900, user: admin });
    let answerFirst: (response: Response) => void = () => undefined;
    let requests = 0;
    const { calls } = stubFetch({
      [LIST]: () => {
        requests += 1;
        return requests === 1
          ? new Promise<Response>((resolve) => {
              answerFirst = resolve;
            })
          : ok({ items: [row({ ...member, email: 'loaded-for-b@example.com' })], total: 1 });
      },
    });
    renderRoute('/admin/users');
    await expect.poll(() => calls.length).toBe(1);
    // What a refresh does when the cookie now belongs to someone else.
    act(() => {
      setSession({ accessToken: 'token-b', expiresIn: 900, user: otherAdmin });
    });
    await act(async () => {
      answerFirst(ok({ items: [row({ ...member, email: 'loaded-for-a@example.com' })], total: 1 }));
      await Promise.resolve();
    });
    expect(
      await screen.findByRole('cell', { name: 'loaded-for-b@example.com' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'loaded-for-a@example.com' })).toBeNull();
    expect(calls.map((call) => call.headers.get('Authorization'))).toEqual([
      'Bearer token-a',
      'Bearer token-b',
    ]);
  });
});

describe('a request whose renewal fails while the session is kept', () => {
  it('fails as unavailable, never with "session ended"', async () => {
    setSession({ accessToken: 'admin-token', expiresIn: 900, user: admin });
    stubFetch({
      // The access token expired, and the refresh hit a server error: the
      // session is kept (docs/error-handling.md).
      [LIST]: () => failure(401, 'Invalid or expired access token'),
      'POST /api/auth/refresh': () => failure(503, 'Service temporarily unavailable'),
    });
    renderRoute('/admin/users');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The service is unavailable');
    expect(alert).not.toHaveTextContent('Your session has ended');
    expect(getState().status).toBe('authenticated');
  });
});

import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteErrorPage } from './RouteErrorPage';

function Broken(): never {
  throw new Error('chunk failed to load');
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('RouteErrorPage', () => {
  it('takes an emailed link token out of the address bar when its page failed to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.history.replaceState(null, '', `/reset-password#token=${'t'.repeat(43)}`);
    const router = createMemoryRouter(
      [{ path: '*', element: <Broken />, errorElement: <RouteErrorPage /> }],
      { initialEntries: ['/reset-password'] },
    );
    render(<RouterProvider router={router} />);
    expect(
      await screen.findByRole('heading', { name: 'Something went wrong' }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/reset-password');
  });
});

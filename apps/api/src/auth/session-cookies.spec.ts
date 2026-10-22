import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { REFRESH_COOKIE, SESSION_HINT_COOKIE } from './auth.constants.js';
import { clearSessionCookies, respondWithSession } from './session-cookies.js';

const session = {
  accessToken: 'access',
  expiresIn: 900,
  sessionId: '7d3c1c2e-5f1a-4b8e-9a51-0c6f2b9e4d10',
  user: { id: 'u1', email: 'a@example.test', name: 'A', role: 'member' as const },
};
const refresh = {
  token: 'refresh',
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  familyId: '7d3c1c2e-5f1a-4b8e-9a51-0c6f2b9e4d10',
};

function response() {
  return { cookie: vi.fn(), clearCookie: vi.fn() };
}

describe('session cookies', () => {
  it('answers with the refresh token as its httpOnly cookie, the hint, and the access token in the body', () => {
    const res = response();
    const body = respondWithSession(res as unknown as Response, { session, refresh }, 'Signed in');
    expect(body).toEqual({ data: session, message: 'Signed in' });
    expect(res.cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'refresh',
      expect.objectContaining({ httpOnly: true, expires: refresh.expiresAt }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      SESSION_HINT_COOKIE,
      '1',
      expect.objectContaining({ httpOnly: false }),
    );
    expect(JSON.stringify(body)).not.toContain('refresh');
  });

  it('clears both cookies with the options they were set with', () => {
    const res = response();
    clearSessionCookies(res as unknown as Response);
    expect(res.clearCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      expect.objectContaining({ httpOnly: true }),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(SESSION_HINT_COOKIE, expect.anything());
  });
});

import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../test/app.js';
import { bearer, cookiesOf, seedUser, signIn, TEST_PASSWORD } from '../../test/auth.js';
import { envelopeOf } from '../../test/http.js';
import { env } from '../env/env.js';
import { PrismaClient } from '../prisma/generated/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { REFRESH_REUSE_LEEWAY_SEC, SIGN_IN_RATE_LIMIT } from './auth.constants.js';
import { hashPassword } from './password.js';
import { hashRefreshToken, RefreshRaceLostException, SessionsService } from './sessions.service.js';

const EMAIL = 'user@example.com';
const tokenOf = (cookie: string) => cookie.slice(cookie.indexOf('=') + 1);
const accessTokenOf = (res: request.Response) =>
  envelopeOf<{ accessToken: string }>(res).data.accessToken;
/** The `refresh_token=<value>` pair a response set, ready for a Cookie header. */
const refreshCookieOf = (res: request.Response) =>
  cookiesOf(res)
    .find((cookie) => cookie.startsWith('refresh_token='))
    ?.split(';', 1)[0] ?? '';
const clearsCookies = (res: request.Response) =>
  ['refresh_token=;', 'has_session=;'].every((prefix) =>
    cookiesOf(res).some((cookie) => cookie.startsWith(prefix)),
  );

describe('Auth (integration)', () => {
  let t: TestApp;

  // A fresh app per test: the rate limiter's in-memory counters start empty.
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedUser(t.prisma, { email: EMAIL });
  });

  afterEach(async () => {
    await t.app.close();
  });

  it('signs in: access token in the body, refresh token in an httpOnly cookie', async () => {
    const res = await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: '  User@Example.com ', password: TEST_PASSWORD })
      .expect(200);

    expect(res.body).toMatchObject({
      data: { expiresIn: 900, user: { email: EMAIL, role: 'member' } },
      message: 'Signed in',
    });
    const cookies = cookiesOf(res);
    const refresh = cookies.find((cookie) => cookie.startsWith('refresh_token='));
    expect(refresh).toMatch(/; HttpOnly/i);
    expect(refresh).toMatch(/; Path=\/api\/auth/i);
    expect(refresh).toMatch(/; SameSite=Strict/i);
    // Secure only in production, where the app is served over HTTPS.
    expect(refresh).not.toMatch(/; Secure/i);
    const hint = cookies.find((cookie) => cookie.startsWith('has_session='));
    expect(hint).toBeDefined();
    expect(hint).not.toMatch(/HttpOnly/i);
    // The refresh token itself never appears in a body.
    expect(JSON.stringify(res.body)).not.toContain(tokenOf(refresh?.split(';')[0] ?? ''));
  });

  it('gives one answer for a wrong password and an unknown email', async () => {
    const wrong = await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: EMAIL, password: 'wrong-password' })
      .expect(401);
    const unknown = await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: 'nobody@example.com', password: 'wrong-password' })
      .expect(401);
    expect(wrong.body).toEqual({ data: null, message: 'Invalid email or password' });
    expect(unknown.body).toEqual(wrong.body);
    expect(cookiesOf(wrong)).toEqual([]);
  });

  it('validates the body before touching the database', async () => {
    const res = await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: 'not-an-email' })
      .expect(400);
    const { data, message } = envelopeOf(res);
    expect(data).toBeNull();
    expect(message).toMatch(/email/);
    expect(message).toMatch(/password/);
  });

  it('rotates the refresh token: new cookie, new access token', async () => {
    const first = await signIn(t.server, EMAIL);
    const res = await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', first.refreshCookie)
      .expect(200);

    expect(refreshCookieOf(res)).not.toBe(first.refreshCookie);
    await request(t.server)
      .get('/api/users/me')
      .set(bearer(accessTokenOf(res)))
      .expect(200);
  });

  it('treats an immediate replay as a lost race and keeps the session alive', async () => {
    const first = await signIn(t.server, EMAIL);
    const rotated = await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', first.refreshCookie)
      .expect(200);
    const replay = await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', first.refreshCookie)
      .expect(401);
    // No cookie clearing: the winner's cookie must survive in the browser.
    expect(cookiesOf(replay)).toEqual([]);

    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookieOf(rotated))
      .expect(200);
  });

  it('ends the whole session family when an old rotated token is replayed (theft)', async () => {
    const first = await signIn(t.server, EMAIL);
    const otherDevice = await signIn(t.server, EMAIL);
    const rotated = await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', first.refreshCookie)
      .expect(200);
    // Age the rotation beyond the race leeway.
    await t.prisma.session.updateMany({
      where: { tokenHash: hashRefreshToken(tokenOf(first.refreshCookie)) },
      data: { revokedAt: new Date(Date.now() - (REFRESH_REUSE_LEEWAY_SEC + 5) * 1000) },
    });

    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const replay = await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', first.refreshCookie)
      .expect(401);
    expect(clearsCookies(replay)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Refresh token reuse'));

    // The thief's copy and the victim's current token are both dead...
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookieOf(rotated))
      .expect(401);
    // ...while the user's other sign-in is untouched.
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', otherDevice.refreshCookie)
      .expect(200);
  });

  it('refuses a refresh without the cookie', async () => {
    const res = await request(t.server).post('/api/auth/refresh').expect(401);
    expect(res.body).toEqual({ data: null, message: 'Missing refresh token' });
  });

  it('refuses two refresh cookies rather than guessing which one is ours', async () => {
    const session = await signIn(t.server, EMAIL);
    const res = await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', `${session.refreshCookie}; refresh_token=planted-by-a-sibling-site`)
      .expect(401);
    expect(res.body).toEqual({ data: null, message: 'Ambiguous session cookies' });
    // Clearing would delete only our cookie, and the next refresh would then
    // sign the user in to the planted session.
    expect(cookiesOf(res)).toEqual([]);
  });

  it('refuses a sign-in whose password changed while it was being checked', async () => {
    const sessions = t.app.get(SessionsService);
    const create = sessions.create.bind(sessions);
    vi.spyOn(sessions, 'create').mockImplementationOnce(async (userId, verifiedHash) => {
      // A password change commits between the check and the session.
      await t.prisma.user.update({
        where: { id: userId },
        data: { passwordHash: await hashPassword('a-brand-new-password') },
      });
      return create(userId, verifiedHash);
    });
    await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: EMAIL, password: TEST_PASSWORD })
      .expect(401);
    await expect(t.prisma.session.count()).resolves.toBe(0);
  });

  it('keeps the cookies when the refresh fails on the server side', async () => {
    const session = await signIn(t.server, EMAIL);
    vi.spyOn(t.app.get(SessionsService), 'rotate').mockRejectedValueOnce(
      new Error('connection terminated'),
    );
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const res = await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .expect(500);
    // The session may well be fine: a database failover must not sign anyone out.
    expect(cookiesOf(res)).toEqual([]);
  });

  it('logs out: the session family is ended and both cookies are cleared', async () => {
    const session = await signIn(t.server, EMAIL);
    const res = await request(t.server)
      .post('/api/auth/logout')
      .set('Cookie', session.refreshCookie)
      .expect(204);
    expect(clearsCookies(res)).toBe(true);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .expect(401);
  });

  it('logs out with a token that was just rotated: the current one dies too', async () => {
    const first = await signIn(t.server, EMAIL);
    const rotated = await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', first.refreshCookie)
      .expect(200);
    // A tab that missed the rotation signs out with the previous token.
    await request(t.server).post('/api/auth/logout').set('Cookie', first.refreshCookie).expect(204);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookieOf(rotated))
      .expect(401);
  });

  it('keeps the cookies when the logout fails on the server side, so a retry ends the session', async () => {
    const session = await signIn(t.server, EMAIL);
    vi.spyOn(t.app.get(SessionsService), 'retire').mockRejectedValueOnce(
      new Error('connection terminated'),
    );
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const failed = await request(t.server)
      .post('/api/auth/logout')
      .set('Cookie', session.refreshCookie)
      .expect(500);
    // Cleared now, the cookie would leave the retry nothing to end the session with.
    expect(cookiesOf(failed)).toEqual([]);
    const retried = await request(t.server)
      .post('/api/auth/logout')
      .set('Cookie', session.refreshCookie)
      .expect(204);
    expect(clearsCookies(retried)).toBe(true);
    await expect(t.prisma.session.count({ where: { revokedAt: null } })).resolves.toBe(0);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .expect(401);
  });

  it('ends only the sessions a logout names, and gives a live one started meanwhile its hint back', async () => {
    const signInFresh = () =>
      request(t.server)
        .post('/api/auth/sign-in')
        .send({ email: EMAIL, password: TEST_PASSWORD })
        .expect(200);
    const idOf = (res: request.Response) => envelopeOf<{ sessionId: string }>(res).data.sessionId;
    // A session the browser discarded (it answered after a sign-out it raced),
    // rotated since by another tab: the id stays the same across rotations.
    const discarded = await signInFresh();
    const rotated = await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookieOf(discarded))
      .expect(200);
    expect(idOf(rotated)).toBe(idOf(discarded));
    const newer = await signInFresh();

    // The jar holds the newer session: left alone, its hint set again.
    const kept = await request(t.server)
      .post('/api/auth/logout')
      .set('Cookie', refreshCookieOf(newer))
      .send({ sessionIds: [idOf(discarded)] })
      .expect(204);
    expect(cookiesOf(kept).some((cookie) => cookie.startsWith('refresh_token='))).toBe(false);
    expect(cookiesOf(kept).find((cookie) => cookie.startsWith('has_session='))).toMatch(
      /^has_session=1; .*Expires=/,
    );
    await expect(
      t.prisma.session.count({ where: { familyId: idOf(newer), revokedAt: null } }),
    ).resolves.toBe(1);

    // The jar holds the discarded family (its rotated cookie): ended, cleared.
    const ended = await request(t.server)
      .post('/api/auth/logout')
      .set('Cookie', refreshCookieOf(rotated))
      .send({ sessionIds: [idOf(discarded)] })
      .expect(204);
    expect(clearsCookies(ended)).toBe(true);
    await expect(
      t.prisma.session.count({ where: { familyId: idOf(discarded), revokedAt: null } }),
    ).resolves.toBe(0);
    await expect(
      t.prisma.session.count({ where: { familyId: idOf(newer), revokedAt: null } }),
    ).resolves.toBe(1);

    // No cookie: nothing to end, no cookie touched. A malformed id: refused.
    const none = await request(t.server)
      .post('/api/auth/logout')
      .send({ sessionIds: [idOf(discarded)] })
      .expect(204);
    expect(cookiesOf(none)).toEqual([]);
    await request(t.server)
      .post('/api/auth/logout')
      .set('Cookie', refreshCookieOf(newer))
      .send({ sessionIds: ['not-a-session'] })
      .expect(400);
    await expect(
      t.prisma.session.count({ where: { familyId: idOf(newer), revokedAt: null } }),
    ).resolves.toBe(1);
  });

  it('tries each refresh cookie of a logout that names its sessions: only the named one ends', async () => {
    const signInFresh = () =>
      request(t.server)
        .post('/api/auth/sign-in')
        .send({ email: EMAIL, password: TEST_PASSWORD })
        .expect(200);
    const idOf = (res: request.Response) => envelopeOf<{ sessionId: string }>(res).data.sessionId;
    const discarded = await signInFresh();
    // Another family's cookie next to it, as one planted for a parent domain.
    const planted = await signInFresh();
    const res = await request(t.server)
      .post('/api/auth/logout')
      .set('Cookie', `${refreshCookieOf(planted)}; ${refreshCookieOf(discarded)}`)
      // An id in upper case names the same session.
      .send({ sessionIds: [idOf(discarded).toUpperCase()] })
      .expect(204);
    expect(clearsCookies(res)).toBe(true);
    await expect(
      t.prisma.session.count({ where: { familyId: idOf(discarded), revokedAt: null } }),
    ).resolves.toBe(0);
    await expect(
      t.prisma.session.count({ where: { familyId: idOf(planted), revokedAt: null } }),
    ).resolves.toBe(1);
  });

  it('gives a live session left alone no hint back when the refresh cookies are ambiguous', async () => {
    const live = await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: EMAIL, password: TEST_PASSWORD })
      .expect(200);
    const res = await request(t.server)
      .post('/api/auth/logout')
      // An empty second cookie makes the pair ambiguous: a refresh refuses it.
      .set('Cookie', `refresh_token=; ${refreshCookieOf(live)}`)
      .send({ sessionIds: ['3b1e8d42-6c7a-4f0e-9d25-7a8c1e4b6f30'] })
      .expect(204);
    expect(cookiesOf(res)).toEqual([]);
  });

  it("logs out like before with an empty JSON body: the cookie's session, whichever it is", async () => {
    const session = await signIn(t.server, EMAIL);
    const res = await request(t.server)
      .post('/api/auth/logout')
      .set('Cookie', session.refreshCookie)
      .send({})
      .expect(204);
    expect(clearsCookies(res)).toBe(true);
    await expect(t.prisma.session.count({ where: { revokedAt: null } })).resolves.toBe(0);
  });

  it('ends the session this browser already had when it signs in again', async () => {
    const before = await signIn(t.server, EMAIL);
    const again = await request(t.server)
      .post('/api/auth/sign-in')
      .set('Cookie', before.refreshCookie)
      .send({ email: EMAIL, password: TEST_PASSWORD })
      .expect(200);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', before.refreshCookie)
      .expect(401);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookieOf(again))
      .expect(200);
  });

  it('refuses requests another site made the browser send (CSRF), on every route', async () => {
    const session = await signIn(t.server, EMAIL);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', 'https://attacker.example.net')
      .expect(403);
    // A sibling subdomain is "same-site", not same-origin: refused too.
    await request(t.server)
      .post('/api/auth/sign-in')
      .set('Sec-Fetch-Site', 'same-site')
      .set('Origin', 'https://sibling.example.com')
      .send({ email: EMAIL, password: TEST_PASSWORD })
      .expect(403);
    await request(t.server)
      .get('/api/users/me')
      .set(bearer(session.accessToken))
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(200);
  });

  it('refuses cross-site requests before they count against the rate limit', async () => {
    for (let attempt = 0; attempt <= SIGN_IN_RATE_LIMIT.limit; attempt += 1) {
      await request(t.server)
        .post('/api/auth/sign-in')
        .set('Sec-Fetch-Site', 'cross-site')
        .send({ email: EMAIL, password: 'wrong-password' })
        .expect(403);
    }
    // Another site cannot lock a visitor out of signing in.
    await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: EMAIL, password: TEST_PASSWORD })
      .expect(200);
  });

  it('limits sign-in attempts per client address', async () => {
    for (let attempt = 0; attempt < SIGN_IN_RATE_LIMIT.limit; attempt += 1) {
      await request(t.server)
        .post('/api/auth/sign-in')
        .send({ email: EMAIL, password: 'wrong-password' })
        .expect(401);
    }
    const blocked = await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: EMAIL, password: TEST_PASSWORD })
      .expect(429);
    expect(blocked.body).toEqual({ data: null, message: 'Too many requests, retry later' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('serializes two concurrent refreshes of one token: one wins, the session stays alive', async () => {
    const first = await signIn(t.server, EMAIL);
    const results = await Promise.all(
      [1, 2].map(() =>
        request(t.server).post('/api/auth/refresh').set('Cookie', first.refreshCookie),
      ),
    );
    expect(results.map((res) => res.status).sort()).toEqual([200, 401]);
    const winner = results.find((res) => res.status === 200);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookieOf(winner ?? results[0]!))
      .expect(200);
    await expect(t.prisma.session.count({ where: { revokedAt: null } })).resolves.toBe(1);
  });

  it('settles concurrent refreshes the same way whatever isolation the database defaults to', async () => {
    // A database or role configured with a stricter default isolation (a
    // managed service's parameter, a DBA's choice): every transaction of this
    // client starts SERIALIZABLE unless it says otherwise.
    const url = new URL(env.DATABASE_URL);
    url.searchParams.set('options', '-c default_transaction_isolation=serializable');
    const strict = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString() }),
    });
    try {
      await expect(strict.$queryRaw`SHOW default_transaction_isolation`).resolves.toEqual([
        { default_transaction_isolation: 'serializable' },
      ]);
      // The service only needs the client's queries and transactions.
      const sessions = new SessionsService(strict as unknown as PrismaService);
      const token = tokenOf((await signIn(t.server, EMAIL)).refreshCookie);
      const outcomes = await Promise.allSettled(
        Array.from({ length: 5 }, () => sessions.rotate(token)),
      );

      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      // The others lost a race (401, the cookie the winner set is kept), not a
      // serialization failure (500, and a database error alert).
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBeInstanceOf(RefreshRaceLostException);
        }
      }
      await expect(t.prisma.session.count({ where: { revokedAt: null } })).resolves.toBe(1);
    } finally {
      await strict.$disconnect();
    }
  });

  it('leaves no live session when a logout races a refresh of the same token', async () => {
    const first = await signIn(t.server, EMAIL);
    const [refreshed] = await Promise.all([
      request(t.server).post('/api/auth/refresh').set('Cookie', first.refreshCookie),
      request(t.server).post('/api/auth/logout').set('Cookie', first.refreshCookie),
    ]);
    await expect(t.prisma.session.count({ where: { revokedAt: null } })).resolves.toBe(0);
    if (refreshed.status === 200) {
      await request(t.server)
        .post('/api/auth/refresh')
        .set('Cookie', refreshCookieOf(refreshed))
        .expect(401);
    }
  });
});

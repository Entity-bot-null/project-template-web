import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../../test/app.js';
import { cookiesOf, seedUser, signIn } from '../../../test/auth.js';

// Browsers that send no Fetch Metadata (Safari before 16.4, any page served
// over plain HTTP from a non-local address) still name the page that made
// them send a request in its Origin header. The integration env serves the
// app from APP_ORIGIN=https://app.example.com (vitest.config.int.ts).

const EMAIL = 'origin-check@example.com';

describe('CSRF guard without Fetch Metadata (integration)', () => {
  let t: TestApp;
  let ownOrigin: string;

  beforeAll(async () => {
    t = await createTestApp();
    // A fixed address, so the Host every request carries is known.
    await new Promise<void>((resolve) => t.server.listen(0, '127.0.0.1', resolve));
    ownOrigin = `http://127.0.0.1:${String((t.server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedUser(t.prisma, { email: EMAIL });
  });

  const refreshFrom = (cookie: string, origin?: string) => {
    const pending = request(ownOrigin).post('/api/auth/refresh').set('Cookie', cookie);
    return origin === undefined ? pending : pending.set('Origin', origin);
  };

  it('refuses a request another site made an older browser send, before it touches the session', async () => {
    const session = await signIn(t.server, EMAIL);
    const refused = await refreshFrom(session.refreshCookie, 'https://attacker.example.net');
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ data: null, message: 'Cross-origin request refused' });
    // A sibling subdomain is another origin too, and so is an opaque one
    // (a sandboxed frame, a file).
    await refreshFrom(session.refreshCookie, 'https://sibling.example.com').expect(403);
    await refreshFrom(session.refreshCookie, 'null').expect(403);
    // The refresh token was never rotated: it still works once.
    await refreshFrom(session.refreshCookie).expect(200);
  });

  it("accepts the app's own origin: APP_ORIGIN, or the address the request was sent to", async () => {
    const first = await signIn(t.server, EMAIL);
    const fromApp = await refreshFrom(first.refreshCookie, 'https://app.example.com').expect(200);
    const rotated = cookiesOf(fromApp).find((cookie) => cookie.startsWith('refresh_token='));
    await refreshFrom(rotated?.split(';', 1)[0] ?? '', ownOrigin).expect(200);
  });

  it('lets non-browser clients through: they send no Origin and carry no victim cookie', async () => {
    const session = await signIn(t.server, EMAIL);
    await refreshFrom(session.refreshCookie).expect(200);
  });
});

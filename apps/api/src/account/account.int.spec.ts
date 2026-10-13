import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../test/app.js';
import { bearer, cookiesOf, seedUser, signIn, TEST_PASSWORD } from '../../test/auth.js';
import { envelopeOf } from '../../test/http.js';
import {
  deleteMessagesTo,
  mailTestOptions,
  messagesTo,
  skipWithoutMailpit,
  testAddress,
} from '../../test/mailpit.js';
import { MailWorker } from '../infrastructure/mail/mail-worker.service.js';
import { MAIL_OPTIONS } from '../infrastructure/mail/mail.constants.js';

// Changing the password while signed in, against PostgreSQL and Mailpit: two
// browsers signed in to one account; the one that changes it carries on in a
// new session, the other is signed out at once.

const NEW_PASSWORD = 'violet harbour lantern 7';

describe.skipIf(skipWithoutMailpit)('password change (PostgreSQL + Mailpit)', () => {
  let t: TestApp;
  let worker: MailWorker;
  const addresses: string[] = [];

  async function account() {
    const email = testAddress();
    addresses.push(email);
    return seedUser(t.prisma, { email, name: 'Grace Hopper' });
  }

  const change = (accessToken: string, currentPassword: string, newPassword = NEW_PASSWORD) =>
    request(t.server)
      .post('/api/account/password')
      .set(bearer(accessToken))
      .send({ currentPassword, newPassword });

  beforeEach(async () => {
    t = await createTestApp((builder) =>
      builder.overrideProvider(MAIL_OPTIONS).useValue(mailTestOptions()),
    );
    worker = t.app.get(MailWorker);
    vi.spyOn(worker, 'wake').mockImplementation(() => undefined);
    await resetDatabase(t.prisma);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await t.app.close();
    for (const email of addresses.splice(0)) await deleteMessagesTo(email);
  });

  it('carries this browser on in a new session, signs every other one out at once, and notifies', async () => {
    const grace = await account();
    const here = await signIn(t.server, grace.email);
    const elsewhere = await signIn(t.server, grace.email);

    const res = await change(here.accessToken, TEST_PASSWORD).expect(200);
    const fresh = envelopeOf<{ accessToken: string; user: { email: string } }>(res).data;
    expect(fresh.user.email).toBe(grace.email);
    const freshCookie = cookiesOf(res).find((cookie) => cookie.startsWith('refresh_token='));
    expect(freshCookie).toBeDefined();

    // The other browser: its access token and its refresh cookie, both refused now.
    await request(t.server).get('/api/users/me').set(bearer(elsewhere.accessToken)).expect(401);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', elsewhere.refreshCookie)
      .expect(401);
    // This browser: the old token ended too; the new session works.
    await request(t.server).get('/api/users/me').set(bearer(here.accessToken)).expect(401);
    await request(t.server).get('/api/users/me').set(bearer(fresh.accessToken)).expect(200);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', freshCookie?.split(';', 1)[0] ?? '')
      .expect(200);

    await signIn(t.server, grace.email, NEW_PASSWORD);
    await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: grace.email, password: TEST_PASSWORD })
      .expect(401);
    await worker.runOnce();
    expect((await messagesTo(grace.email)).map((m) => m.Subject)).toEqual([
      'Your Integration password was changed',
    ]);
  });

  it('asks for the current password again: a wrong one changes nothing and signs nobody out', async () => {
    const grace = await account();
    const session = await signIn(t.server, grace.email);
    await change(session.accessToken, 'not the current password').expect(403);
    await request(t.server).get('/api/users/me').set(bearer(session.accessToken)).expect(200);
    await signIn(t.server, grace.email, TEST_PASSWORD);
    expect(await t.prisma.mailMessage.count()).toBe(0);
  });

  it('refuses a weak new password', async () => {
    const grace = await account();
    const session = await signIn(t.server, grace.email);
    for (const weak of ['short one', 'correcthorsebatterystaple', 'grace hopper was here']) {
      await change(session.accessToken, TEST_PASSWORD, weak).expect(400);
    }
  });

  it('lets one of two simultaneous changes through, the other is told it changed meanwhile', async () => {
    const grace = await account();
    const one = await signIn(t.server, grace.email);
    const two = await signIn(t.server, grace.email);
    const results = await Promise.all([
      change(one.accessToken, TEST_PASSWORD, NEW_PASSWORD),
      change(two.accessToken, TEST_PASSWORD, `${NEW_PASSWORD} again`),
    ]);
    // Exactly one wins. The other lost the race inside the transaction (409),
    // or arrived once the winner's new securityVersion had already ended its
    // access token (401): never a second change.
    const statuses = results.map((res) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status !== 200)).toEqual([
      expect.toSatisfy((status: number) => status === 401 || status === 409),
    ]);
    const account2 = await t.prisma.user.findUniqueOrThrow({ where: { id: grace.id } });
    expect(account2.securityVersion).toBe(1);
  });

  it('needs a session, and refuses a request another site made a browser send', async () => {
    await request(t.server)
      .post('/api/account/password')
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(401);
    const grace = await account();
    const session = await signIn(t.server, grace.email);
    await request(t.server)
      .post('/api/account/password')
      .set(bearer(session.accessToken))
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', 'https://evil.example')
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(403);
  });
});

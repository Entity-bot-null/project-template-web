import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../test/app.js';
import { bearer, cookiesOf, seedUser, signIn } from '../../test/auth.js';
import { envelopeOf } from '../../test/http.js';
import {
  deleteMessagesTo,
  mailTestOptions,
  messagesTo,
  readMessage,
  skipWithoutMailpit,
  testAddress,
} from '../../test/mailpit.js';
import { MailWorker } from '../infrastructure/mail/mail-worker.service.js';
import { MAIL_OPTIONS } from '../infrastructure/mail/mail.constants.js';
import { SIGN_UP_ENABLED } from './auth.constants.js';
import { SignUpService } from './sign-up.service.js';

// "Create an account" end to end against PostgreSQL and Mailpit: the link
// comes out of a real message (the database holds only the token's hash),
// and no account exists until it is confirmed with the password chosen.

const PASSWORD = 'violet harbour lantern 7';
const OTHER_PASSWORD = 'quiet orchard compass 42';

interface SignUpApp extends TestApp {
  worker: MailWorker;
  signUps: SignUpService;
}

async function app(enabled = true): Promise<SignUpApp> {
  const t = await createTestApp((builder) =>
    builder
      .overrideProvider(MAIL_OPTIONS)
      .useValue(mailTestOptions())
      .overrideProvider(SIGN_UP_ENABLED)
      .useValue(enabled),
  );
  const worker = t.app.get(MailWorker);
  // The spec decides when messages go out (runOnce), not the poll.
  vi.spyOn(worker, 'wake').mockImplementation(() => undefined);
  return { ...t, worker, signUps: t.app.get(SignUpService) };
}

describe.skipIf(skipWithoutMailpit)('sign-up (PostgreSQL + Mailpit)', () => {
  let t: SignUpApp;
  const addresses: string[] = [];

  function address(): string {
    const email = testAddress();
    addresses.push(email);
    return email;
  }

  const ask = (email: string, password = PASSWORD, name = 'Ada Lovelace') =>
    request(t.server).post('/api/auth/sign-ups').send({ email, name, password });

  /** Signs up, delivers the queue, and returns the newest confirmation link's token sent to `email`. */
  async function linkFor(email: string, password = PASSWORD): Promise<string> {
    await ask(email, password).expect(202);
    await t.signUps.settled();
    await t.worker.runOnce();
    const newest = (await messagesTo(email)).find((m) => m.Subject.startsWith('Confirm your'));
    if (newest === undefined) throw new Error(`no confirmation message to ${email}`);
    const { text } = await readMessage(newest.ID);
    const token = /\/confirm-sign-up#token=([A-Za-z0-9_-]{43})/.exec(text)?.[1];
    if (token === undefined) throw new Error('no confirmation link in the message');
    return token;
  }

  const confirm = (token: string, password = PASSWORD) =>
    request(t.server).post('/api/auth/sign-ups/confirm').send({ token, password });

  beforeEach(async () => {
    t = await app();
    await resetDatabase(t.prisma);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await t.app.close();
    for (const email of addresses.splice(0)) await deleteMessagesTo(email);
  });

  it('creates no account until the link of a real message is confirmed with the password, then signs in', async () => {
    const email = address();
    const token = await linkFor(email);
    expect(await t.prisma.user.count({ where: { email } })).toBe(0);
    await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(401);
    expect(JSON.stringify(await t.prisma.signUp.findMany())).not.toContain(token);
    expect(JSON.stringify(await t.prisma.mailMessage.findMany())).not.toContain(token);
    const [message] = await messagesTo(email);
    const { text } = await readMessage(message?.ID ?? '');
    // The link points at the configured public origin, never at a request's Host.
    expect(text).toContain(`https://app.example.com/confirm-sign-up#token=${token}`);

    const res = await confirm(token).expect(200);
    const session = envelopeOf<{ accessToken: string; user: Record<string, unknown> }>(res).data;
    expect(session.user).toMatchObject({ email, name: 'Ada Lovelace', role: 'member' });
    expect(cookiesOf(res).some((cookie) => cookie.startsWith('refresh_token='))).toBe(true);
    await request(t.server).get('/api/users/me').set(bearer(session.accessToken)).expect(200);
    await signIn(t.server, email, PASSWORD);
    expect(await t.prisma.signUp.count()).toBe(0);
    // The link worked once.
    await confirm(token).expect(404);
  });

  it('answers the same, at once, for a new address and one with an account; the owner gets a notice', async () => {
    const owner = await seedUser(t.prisma, { email: address(), name: 'Grace Hopper' });
    const fresh = address();
    // The lookup and the queueing take long; the answer must not wait for them.
    const original = t.prisma.$transaction.bind(t.prisma) as (...args: unknown[]) => unknown;
    const slow = vi
      .spyOn(t.prisma, '$transaction')
      .mockImplementation((...args: unknown[]) =>
        new Promise((resolve) => setTimeout(resolve, 400)).then(() => original(...args)),
      );
    const answers = [];
    for (const email of [owner.email, fresh]) {
      const started = Date.now();
      const res = await ask(email);
      answers.push({ status: res.status, body: res.text, ms: Date.now() - started });
    }
    // Byte for byte the same answer.
    const [withAccount, without] = answers;
    expect(withAccount?.status).toBe(202);
    expect(withAccount?.body).toBe(without?.body);
    expect(JSON.parse(withAccount?.body ?? '')).toEqual({
      data: null,
      message: 'Operation successful',
    });
    // Hashing the password happens after the answer too.
    for (const { ms } of answers) expect(ms).toBeLessThan(300);
    await t.signUps.settled();
    slow.mockRestore();
    await t.worker.runOnce();
    await t.worker.runOnce();
    expect((await messagesTo(owner.email)).map((m) => m.Subject)).toEqual([
      'Your Integration account already exists',
    ]);
    expect((await messagesTo(fresh)).map((m) => m.Subject)).toEqual([
      'Confirm your Integration account',
    ]);
    // The existing account is untouched, and no sign-up was recorded for it.
    expect(await t.prisma.signUp.findMany({ select: { email: true } })).toEqual([{ email: fresh }]);
  });

  it('cannot be finished without the password chosen: wrong ones count, and the fifth drops the sign-up', async () => {
    const kept = address();
    const keptToken = await linkFor(kept);
    for (let i = 0; i < 2; i++) await confirm(keptToken, OTHER_PASSWORD).expect(401);
    await confirm(keptToken).expect(200);

    const dropped = address();
    const droppedToken = await linkFor(dropped);
    for (let i = 0; i < 5; i++) await confirm(droppedToken, OTHER_PASSWORD).expect(401);
    await confirm(droppedToken).expect(404);
    expect(await t.prisma.user.count({ where: { email: dropped } })).toBe(0);
  });

  it('replaces an earlier sign-up of the address, and its link, with a newer one', async () => {
    const email = address();
    const first = await linkFor(email, PASSWORD);
    // Past the one-message-a-minute limit of the address.
    await t.prisma.mailMessage.updateMany({ data: { createdAt: new Date(Date.now() - 61_000) } });
    const second = await linkFor(email, OTHER_PASSWORD);
    await confirm(first, PASSWORD).expect(404);
    await confirm(second, OTHER_PASSWORD).expect(200);
  });

  it('keeps the earlier sign-up and its link when a newer one is held back by the per-address limit', async () => {
    const email = address();
    const token = await linkFor(email, PASSWORD);
    await ask(email, OTHER_PASSWORD).expect(202);
    await t.signUps.settled();
    expect(await t.prisma.mailMessage.count({ where: { kind: 'sign_up_confirmation' } })).toBe(1);
    await confirm(token, PASSWORD).expect(200);
  });

  it('creates one account from two simultaneous confirmations', async () => {
    const email = address();
    const token = await linkFor(email);
    const results = await Promise.all([confirm(token), confirm(token)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 404]);
    expect(await t.prisma.user.count({ where: { email } })).toBe(1);
  });

  it('answers 409 when the address got an account after the link was sent', async () => {
    const email = address();
    const token = await linkFor(email);
    await seedUser(t.prisma, { email, name: 'Created by an operator' });
    await confirm(token).expect(409);
  });

  it('refuses an expired link, a weak password, and a malformed token', async () => {
    const email = address();
    const token = await linkFor(email);
    await t.prisma.signUp.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    await confirm(token).expect(404);

    const weak = address();
    for (const password of ['too short', 'correcthorsebatterystaple', 'ada lovelace forever']) {
      await ask(weak, password).expect(400);
    }
    await t.signUps.settled();
    expect(await t.prisma.signUp.count({ where: { email: weak } })).toBe(0);
    await confirm('not-a-token').expect(400);
  });

  it('ends the session this browser had, like a sign-in', async () => {
    const before = await seedUser(t.prisma, { email: address(), name: 'Grace Hopper' });
    const session = await signIn(t.server, before.email);
    const email = address();
    const token = await linkFor(email);
    await request(t.server)
      .post('/api/auth/sign-ups/confirm')
      .set('Cookie', session.refreshCookie)
      .send({ token, password: PASSWORD })
      .expect(200);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .expect(401);
  });

  it('limits requests per address of the client', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await ask(`nobody-${String(i)}@example.test`)).status);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    await t.signUps.settled();
  });

  it('says what it offers, and is closed (403) unless enabled', async () => {
    const open = await request(t.server).get('/api/auth/capabilities').expect(200);
    expect(envelopeOf(open).data).toEqual({ passwordReset: true, signUp: true });
    await t.app.close();
    t = await app(false);
    const closed = await request(t.server).get('/api/auth/capabilities').expect(200);
    expect(envelopeOf(closed).data).toEqual({ passwordReset: true, signUp: false });
    await ask('ada@example.test').expect(403);
    await confirm('a'.repeat(43)).expect(403);
  });

  it('refuses a request another site made a browser send', async () => {
    await request(t.server)
      .post('/api/auth/sign-ups')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', 'https://evil.example')
      .send({ email: 'ada@example.test', name: 'Ada', password: PASSWORD })
      .expect(403);
  });
});

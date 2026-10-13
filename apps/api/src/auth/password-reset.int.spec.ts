import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../test/app.js';
import { bearer, seedUser, signIn, TEST_PASSWORD } from '../../test/auth.js';
import { envelopeOf } from '../../test/http.js';
import {
  deleteMessagesTo,
  mailTestOptions,
  messagesTo,
  readMessage,
  skipWithoutMailpit,
  testAddress,
} from '../../test/mailpit.js';
import { MailOutboxService } from '../infrastructure/mail/mail-outbox.service.js';
import { MailWorker } from '../infrastructure/mail/mail-worker.service.js';
import { MAIL_OPTIONS } from '../infrastructure/mail/mail.constants.js';
import type { MailOptions } from '../infrastructure/mail/mail.types.js';
import { PasswordResetService } from './password-reset.service.js';

// "Forgot your password?" end to end against PostgreSQL and Mailpit: the link
// comes out of a real message (the database holds only the token's hash).

const NEW_PASSWORD = 'violet harbour lantern 7';

interface Reset extends TestApp {
  worker: MailWorker;
  resets: PasswordResetService;
}

async function app(overrides: Partial<MailOptions> = {}): Promise<Reset> {
  const t = await createTestApp((builder) =>
    builder.overrideProvider(MAIL_OPTIONS).useValue(mailTestOptions(overrides)),
  );
  const worker = t.app.get(MailWorker);
  // The spec decides when messages go out (runOnce), not the poll.
  vi.spyOn(worker, 'wake').mockImplementation(() => undefined);
  return { ...t, worker, resets: t.app.get(PasswordResetService) };
}

describe.skipIf(skipWithoutMailpit)('password reset (PostgreSQL + Mailpit)', () => {
  let t: Reset;
  const addresses: string[] = [];

  /** A user with TEST_PASSWORD at an address of this spec's own. */
  async function user(name = 'Ada') {
    const email = testAddress();
    addresses.push(email);
    return seedUser(t.prisma, { email, name });
  }

  /** Asks for a link, delivers the queue, and returns the newest link's token sent to `email`. */
  async function linkFor(email: string): Promise<string> {
    await request(t.server).post('/api/auth/password-resets').send({ email }).expect(204);
    await t.resets.settled();
    await t.worker.runOnce();
    const [newest] = await messagesTo(email);
    if (newest === undefined) throw new Error(`no message to ${email}`);
    const { text } = await readMessage(newest.ID);
    const token = /\/reset-password#token=([A-Za-z0-9_-]{43})/.exec(text)?.[1];
    if (token === undefined) throw new Error('no reset link in the message');
    return token;
  }

  const confirm = (token: string, password = NEW_PASSWORD) =>
    request(t.server).post('/api/auth/password-resets/confirm').send({ token, password });

  beforeEach(async () => {
    t = await app();
    await resetDatabase(t.prisma);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await t.app.close();
    for (const email of addresses.splice(0)) await deleteMessagesTo(email);
  });

  it('resets the password with the link of a real message, ends every session at once, and notifies', async () => {
    const ada = await user();
    const before = await signIn(t.server, ada.email);
    await request(t.server).get('/api/users/me').set(bearer(before.accessToken)).expect(200);

    const token = await linkFor(ada.email);
    const [message] = await messagesTo(ada.email);
    const { text } = await readMessage(message?.ID ?? '');
    // The link points at the configured public origin, never at a request's Host.
    expect(text).toContain(`https://app.example.com/reset-password#token=${token}`);
    expect(JSON.stringify(await t.prisma.mailMessage.findMany())).not.toContain(token);
    expect(JSON.stringify(await t.prisma.accountToken.findMany())).not.toContain(token);

    await confirm(token).expect(204);

    // The access token issued before is refused at once, not in 15 minutes.
    await request(t.server).get('/api/users/me').set(bearer(before.accessToken)).expect(401);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', before.refreshCookie)
      .expect(401);
    await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: ada.email, password: TEST_PASSWORD })
      .expect(401);
    await signIn(t.server, ada.email, NEW_PASSWORD);

    await t.worker.runOnce();
    const subjects = (await messagesTo(ada.email)).map((m) => m.Subject);
    expect(subjects).toContain('Your Integration password was changed');
    // The link works once.
    await confirm(token).expect(404);
  });

  it('answers the same, at once, for an address with and without an account, and queues nothing for the latter', async () => {
    const ada = await user();
    // The lookup and the queueing take long; the answer must not wait for them.
    const original = t.prisma.$transaction.bind(t.prisma) as (...args: unknown[]) => unknown;
    const slow = vi
      .spyOn(t.prisma, '$transaction')
      .mockImplementation((...args: unknown[]) =>
        new Promise((resolve) => setTimeout(resolve, 400)).then(() => original(...args)),
      );
    const answers = [];
    for (const email of [ada.email, 'nobody-here@example.test']) {
      const started = Date.now();
      const res = await request(t.server).post('/api/auth/password-resets').send({ email });
      answers.push({ status: res.status, body: res.text, ms: Date.now() - started });
    }
    expect(answers.map(({ status, body }) => ({ status, body }))).toEqual([
      { status: 204, body: '' },
      { status: 204, body: '' },
    ]);
    for (const { ms } of answers) expect(ms).toBeLessThan(300);
    await t.resets.settled();
    slow.mockRestore();
    const queued = await t.prisma.mailMessage.findMany({ select: { kind: true, userId: true } });
    expect(queued).toEqual([{ kind: 'password_reset', userId: ada.id }]);
  });

  it('refuses a weak password without spending the link', async () => {
    const ada = await user('Adeline');
    const token = await linkFor(ada.email);
    for (const weak of ['too short', 'correcthorsebatterystaple', 'adeline and her long tail']) {
      await confirm(token, weak).expect(400);
    }
    await confirm(token).expect(204);
  });

  it('lets only one of two simultaneous uses of a link through', async () => {
    const ada = await user();
    const token = await linkFor(ada.email);
    const results = await Promise.all([confirm(token), confirm(token, `${NEW_PASSWORD} 2`)]);
    expect(results.map((res) => res.status).sort()).toEqual([204, 404]);
    expect(await t.prisma.accountToken.count({ where: { usedAt: { not: null } } })).toBe(1);
  });

  it('refuses an expired link, and one minted before the account changed', async () => {
    const ada = await user();
    const token = await linkFor(ada.email);
    await t.prisma.accountToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    await confirm(token).expect(404);

    const bob = await user('Bob');
    const stale = await linkFor(bob.email);
    // A credential change in between (another reset, a change while signed in).
    await t.prisma.user.update({
      where: { id: bob.id },
      data: { securityVersion: { increment: 1 } },
    });
    await confirm(stale).expect(404);
  });

  it('keeps only the newest link working when one is asked for again', async () => {
    const ada = await user();
    const first = await linkFor(ada.email);
    // Past the one-message-a-minute limit of the address.
    await t.prisma.mailMessage.updateMany({ data: { createdAt: new Date(Date.now() - 61_000) } });
    const second = await linkFor(ada.email);
    expect(second).not.toBe(first);
    await confirm(first).expect(404);
    await confirm(second).expect(204);
  });

  it('holds back a second message to one address within a minute, answering the same', async () => {
    const ada = await user();
    await linkFor(ada.email);
    await request(t.server)
      .post('/api/auth/password-resets')
      .send({ email: ada.email })
      .expect(204);
    await t.resets.settled();
    expect(await t.prisma.mailMessage.count({ where: { kind: 'password_reset' } })).toBe(1);
  });

  it('changes nothing when the transaction fails part way: the link and the sessions survive', async () => {
    const ada = await user();
    const session = await signIn(t.server, ada.email);
    const token = await linkFor(ada.email);
    const outbox = t.app.get(MailOutboxService);
    vi.spyOn(outbox, 'enqueue').mockRejectedValueOnce(new Error('database failed mid-way'));
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await confirm(token).expect(500);
    await request(t.server).get('/api/users/me').set(bearer(session.accessToken)).expect(200);
    await signIn(t.server, ada.email, TEST_PASSWORD);
    await confirm(token).expect(204);
  });

  it('limits requests per address of the client', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(t.server)
        .post('/api/auth/password-resets')
        .send({ email: `nobody-${String(i)}@example.test` });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([204, 204, 204, 204, 204, 429]);
  });

  it('says what it offers, and answers 503 for a reset when email is off', async () => {
    const capabilities = await request(t.server).get('/api/auth/capabilities').expect(200);
    expect(envelopeOf(capabilities).data).toEqual({
      passwordReset: true,
      signUp: false,
      emailChange: true,
    });
    await t.app.close();
    t = await app({ smtpUrl: undefined });
    const off = await request(t.server).get('/api/auth/capabilities').expect(200);
    expect(envelopeOf(off).data).toEqual({
      passwordReset: false,
      signUp: false,
      emailChange: false,
    });
    await request(t.server)
      .post('/api/auth/password-resets')
      .send({ email: 'ada@example.test' })
      .expect(503);
  });

  it('refuses a malformed token before any lookup, and a request from another site', async () => {
    await confirm('not-a-token').expect(400);
    await request(t.server)
      .post('/api/auth/password-resets')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', 'https://evil.example')
      .send({ email: 'ada@example.test' })
      .expect(403);
  });
});

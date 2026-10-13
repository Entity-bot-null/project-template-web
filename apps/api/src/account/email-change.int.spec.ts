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
import { MailWorker } from '../infrastructure/mail/mail-worker.service.js';
import { MAIL_OPTIONS } from '../infrastructure/mail/mail.constants.js';
import type { MailOptions } from '../infrastructure/mail/mail.types.js';
import { EmailChangeService } from './email-change.service.js';

// Changing the address of an account against PostgreSQL and Mailpit: links
// out of real messages, and the attack the undo link exists for.

const NEW_PASSWORD = 'violet harbour lantern 7';
const CONFIRM_LINK = /\/confirm-email-change#token=([A-Za-z0-9_-]{43})/;
const REVERT_LINK = /\/revert-email-change#token=([A-Za-z0-9_-]{43})/;

interface EmailApp extends TestApp {
  worker: MailWorker;
  changes: EmailChangeService;
}

async function app(overrides: Partial<MailOptions> = {}): Promise<EmailApp> {
  const t = await createTestApp((builder) =>
    builder.overrideProvider(MAIL_OPTIONS).useValue(mailTestOptions(overrides)),
  );
  const worker = t.app.get(MailWorker);
  // The spec decides when messages go out (runOnce), not the poll.
  vi.spyOn(worker, 'wake').mockImplementation(() => undefined);
  return { ...t, worker, changes: t.app.get(EmailChangeService) };
}

describe.skipIf(skipWithoutMailpit)('change of email (PostgreSQL + Mailpit)', () => {
  let t: EmailApp;
  const addresses: string[] = [];

  function address(): string {
    const email = testAddress();
    addresses.push(email);
    return email;
  }

  async function account(name = 'Grace Hopper') {
    return seedUser(t.prisma, { email: address(), name });
  }

  const ask = (accessToken: string, newEmail: string, currentPassword = TEST_PASSWORD) =>
    request(t.server)
      .post('/api/account/email')
      .set(bearer(accessToken))
      .send({ currentPassword, newEmail });

  /** Delivers the queue and returns the newest link's token of `subject` sent to `to`. */
  async function linkIn(to: string, subject: string, link: RegExp): Promise<string> {
    await t.changes.settled();
    // Sends every due message.
    await t.worker.runOnce();
    const found = (await messagesTo(to)).find((m) => m.Subject === subject);
    if (found === undefined) throw new Error(`no "${subject}" message to ${to}`);
    const { text } = await readMessage(found.ID);
    const token = link.exec(text)?.[1];
    if (token === undefined) throw new Error(`no ${link.source} link in the message`);
    return token;
  }

  const confirm = (token: string) =>
    request(t.server).post('/api/auth/email-changes/confirm').send({ token });
  const revert = (token: string, password = NEW_PASSWORD) =>
    request(t.server).post('/api/auth/email-changes/revert').send({ token, password });

  beforeEach(async () => {
    t = await app();
    await resetDatabase(t.prisma);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await t.app.close();
    for (const email of addresses.splice(0)) await deleteMessagesTo(email);
  });

  it('moves the account with the link sent to the new address, ends every session, and tells the previous one', async () => {
    const grace = await account();
    const session = await signIn(t.server, grace.email);
    const target = address();
    await ask(session.accessToken, target).expect(202);
    const token = await linkIn(target, 'Confirm your new Integration address', CONFIRM_LINK);
    // Nothing changes until the link is used.
    await request(t.server).get('/api/users/me').set(bearer(session.accessToken)).expect(200);
    expect(JSON.stringify(await t.prisma.accountToken.findMany())).not.toContain(token);

    await confirm(token).expect(204);
    await request(t.server).get('/api/users/me').set(bearer(session.accessToken)).expect(401);
    await request(t.server)
      .post('/api/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .expect(401);
    await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: grace.email, password: TEST_PASSWORD })
      .expect(401);
    await signIn(t.server, target, TEST_PASSWORD);
    // The previous address is told, with a way back; the link worked once.
    await linkIn(grace.email, 'Your Integration address was changed', REVERT_LINK);
    await confirm(token).expect(404);
  });

  it('answers the same, at once, for an address that has an account; its owner is told and nothing changes', async () => {
    const grace = await account();
    const owner = await account('Katherine Johnson');
    const session = await signIn(t.server, grace.email);
    const original = t.prisma.$transaction.bind(t.prisma) as (...args: unknown[]) => unknown;
    const slow = vi
      .spyOn(t.prisma, '$transaction')
      .mockImplementation((...args: unknown[]) =>
        new Promise((resolve) => setTimeout(resolve, 400)).then(() => original(...args)),
      );
    const answers = [];
    for (const email of [owner.email, address()]) {
      const started = Date.now();
      const res = await ask(session.accessToken, email);
      answers.push({ status: res.status, body: res.text, ms: Date.now() - started });
    }
    const [taken, free] = answers;
    expect(taken?.status).toBe(202);
    expect(taken?.body).toBe(free?.body);
    for (const { ms } of answers) expect(ms).toBeLessThan(300);
    await t.changes.settled();
    slow.mockRestore();
    // Sends every due message.
    await t.worker.runOnce();
    expect((await messagesTo(owner.email)).map((m) => m.Subject)).toEqual([
      'Your Integration address was not changed',
    ]);
    const unchanged = await t.prisma.user.findUniqueOrThrow({ where: { id: grace.id } });
    expect(unchanged.email).toBe(grace.email);
  });

  it('undoes the change even after whoever took the account moved it again and changed the password', async () => {
    const grace = await account();
    // Someone else holds a session of the account and knows its password.
    const thief = await signIn(t.server, grace.email);
    const first = address();
    await ask(thief.accessToken, first).expect(202);
    await confirm(await linkIn(first, 'Confirm your new Integration address', CONFIRM_LINK)).expect(
      204,
    );
    const undo = await linkIn(grace.email, 'Your Integration address was changed', REVERT_LINK);

    // They move on: a new password, then another address.
    const again = await signIn(t.server, first, TEST_PASSWORD);
    const changed = await request(t.server)
      .post('/api/account/password')
      .set(bearer(again.accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'quiet orchard compass 42' })
      .expect(200);
    const thiefToken = envelopeOf<{ accessToken: string }>(changed).data.accessToken;
    const second = address();
    await ask(thiefToken, second, 'quiet orchard compass 42').expect(202);
    await confirm(
      await linkIn(second, 'Confirm your new Integration address', CONFIRM_LINK),
    ).expect(204);
    const theirUndo = await linkIn(first, 'Your Integration address was changed', REVERT_LINK);

    // The owner's link, from the first change, still works.
    await revert(undo).expect(204);
    const restored = await t.prisma.user.findUniqueOrThrow({ where: { id: grace.id } });
    expect(restored.email).toBe(grace.email);
    await signIn(t.server, grace.email, NEW_PASSWORD);
    for (const [email, password] of [
      [second, 'quiet orchard compass 42'],
      [grace.email, 'quiet orchard compass 42'],
      [grace.email, TEST_PASSWORD],
    ] as const) {
      await request(t.server).post('/api/auth/sign-in').send({ email, password }).expect(401);
    }
    await request(t.server).get('/api/users/me').set(bearer(thiefToken)).expect(401);
    // Every other link of the account died with it.
    await revert(theirUndo).expect(404);
    await revert(undo).expect(404);
  });

  it("keeps the owner's undo link when whoever took the account undoes their own later change first", async () => {
    const grace = await account();
    // Someone else holds a session of the account and knows its password.
    const thief = await signIn(t.server, grace.email);
    const first = address();
    await ask(thief.accessToken, first).expect(202);
    await confirm(await linkIn(first, 'Confirm your new Integration address', CONFIRM_LINK)).expect(
      204,
    );
    const ownersUndo = await linkIn(
      grace.email,
      'Your Integration address was changed',
      REVERT_LINK,
    );
    // They change it again, which mails an undo link for that change to
    // their first address, and use it at once with a password of theirs.
    const again = await signIn(t.server, first, TEST_PASSWORD);
    const second = address();
    await ask(again.accessToken, second).expect(202);
    await confirm(
      await linkIn(second, 'Confirm your new Integration address', CONFIRM_LINK),
    ).expect(204);
    const theirUndo = await linkIn(first, 'Your Integration address was changed', REVERT_LINK);
    await revert(theirUndo, 'quiet orchard compass 42').expect(204);

    // The owner's link, the earliest, still works and wins.
    await revert(ownersUndo).expect(204);
    const restored = await t.prisma.user.findUniqueOrThrow({ where: { id: grace.id } });
    expect(restored.email).toBe(grace.email);
    await signIn(t.server, grace.email, NEW_PASSWORD);
    await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: first, password: 'quiet orchard compass 42' })
      .expect(401);
  });

  it('asks for the current password, refuses the same address, and queues nothing then', async () => {
    const grace = await account();
    const session = await signIn(t.server, grace.email);
    await ask(session.accessToken, address(), 'not the password').expect(403);
    await ask(session.accessToken, ` ${grace.email.toUpperCase()} `).expect(400);
    await t.changes.settled();
    expect(await t.prisma.mailMessage.count()).toBe(0);
  });

  it('voids a confirmation link once the account changed (a new password)', async () => {
    const grace = await account();
    const session = await signIn(t.server, grace.email);
    const target = address();
    await ask(session.accessToken, target).expect(202);
    const token = await linkIn(target, 'Confirm your new Integration address', CONFIRM_LINK);
    await request(t.server)
      .post('/api/account/password')
      .set(bearer(session.accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(200);
    await confirm(token).expect(404);
  });

  it('lets only one of two simultaneous confirmations through, and answers 409 for a taken address', async () => {
    const grace = await account();
    const session = await signIn(t.server, grace.email);
    const target = address();
    await ask(session.accessToken, target).expect(202);
    const token = await linkIn(target, 'Confirm your new Integration address', CONFIRM_LINK);
    const results = await Promise.all([confirm(token), confirm(token)]);
    expect(results.map((res) => res.status).sort()).toEqual([204, 404]);

    const ada = await account('Ada Lovelace');
    const adaSession = await signIn(t.server, ada.email);
    const contested = address();
    await ask(adaSession.accessToken, contested).expect(202);
    const adaToken = await linkIn(contested, 'Confirm your new Integration address', CONFIRM_LINK);
    await seedUser(t.prisma, { email: contested, name: 'Arrived meanwhile' });
    await confirm(adaToken).expect(409);
  });

  it('keeps the undo link through a refused password, and refuses an expired one', async () => {
    const grace = await account('Adeline Byron');
    const session = await signIn(t.server, grace.email);
    const target = address();
    await ask(session.accessToken, target).expect(202);
    await confirm(
      await linkIn(target, 'Confirm your new Integration address', CONFIRM_LINK),
    ).expect(204);
    const undo = await linkIn(grace.email, 'Your Integration address was changed', REVERT_LINK);
    for (const weak of ['too short', 'correcthorsebatterystaple', 'adeline and her long tail']) {
      await revert(undo, weak).expect(400);
    }
    await t.prisma.accountToken.updateMany({
      where: { purpose: 'email_revert' },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await revert(undo).expect(404);
  });

  it('says what it offers, answers 503 without email, and needs a session to ask', async () => {
    const offered = await request(t.server).get('/api/auth/capabilities').expect(200);
    expect(envelopeOf<{ emailChange: boolean }>(offered).data.emailChange).toBe(true);
    await request(t.server)
      .post('/api/account/email')
      .send({ currentPassword: TEST_PASSWORD, newEmail: 'new@example.test' })
      .expect(401);
    await request(t.server)
      .post('/api/auth/email-changes/confirm')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', 'https://evil.example')
      .send({ token: 'a'.repeat(43) })
      .expect(403);
    await confirm('not-a-token').expect(400);

    await t.app.close();
    t = await app({ smtpUrl: undefined });
    const off = await request(t.server).get('/api/auth/capabilities').expect(200);
    expect(envelopeOf<{ emailChange: boolean }>(off).data.emailChange).toBe(false);
    const grace = await account();
    const session = await signIn(t.server, grace.email);
    await ask(session.accessToken, address()).expect(503);
  });
});

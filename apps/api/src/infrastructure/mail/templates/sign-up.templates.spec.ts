import { describe, expect, it, vi } from 'vitest';
import { hashAccountToken } from '../../../auth/account-tokens.js';
import type { Prisma } from '../../../prisma/generated/client.js';
import type { ClaimedMessage } from '../mail.types.js';
import { signUpConfirmationTemplate } from './sign-up-confirmation.template.js';
import { signUpExistingTemplate } from './sign-up-existing.template.js';

const SIGN_UP_ID = '0190b6a1-0000-7000-8000-0000000000aa';

const message = (overrides: Partial<ClaimedMessage> = {}): ClaimedMessage => ({
  id: 'm1',
  kind: 'sign_up_confirmation',
  recipient: 'ada@example.test',
  userId: null,
  payload: { signUpId: SIGN_UP_ID },
  attempts: 1,
  attemptsBase: 0,
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  requestId: null,
  ...overrides,
});

interface Rows {
  /** What the sign-up lookup finds; null: none. */
  signUp?: { id: string; email: string } | null;
  /** What the account lookup finds; null: none. */
  user?: Record<string, unknown> | null;
}

function txWith({
  signUp = { id: SIGN_UP_ID, email: 'ada@example.test' },
  user = null,
}: Rows = {}) {
  const tx = {
    signUp: {
      findUnique: vi.fn(() => Promise.resolve(signUp)),
      update: vi.fn(() => Promise.resolve({})),
    },
    user: { findUnique: vi.fn(() => Promise.resolve(user)) },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}

const context = { product: 'Acme', appUrl: 'https://app.acme.test/app' };

describe('the sign-up confirmation message', () => {
  it('mints its token when it is sent, after # in a link to the configured origin, only its hash stored', async () => {
    const { tx, client } = txWith();
    const before = Date.now();
    const rendered = await signUpConfirmationTemplate.compose({
      tx: client,
      message: message(),
      ...context,
    });
    const token = /https:\/\/app\.acme\.test\/app\/confirm-sign-up#token=([A-Za-z0-9_-]{43})/.exec(
      rendered?.text ?? '',
    )?.[1];
    expect(token).toBeDefined();
    const [[{ where, data }]] = tx.signUp.update.mock.calls as unknown as [
      [{ where: unknown; data: { tokenHash: string; expiresAt: Date } }],
    ];
    expect(where).toEqual({ id: SIGN_UP_ID });
    expect(data.tokenHash).toBe(hashAccountToken(token ?? ''));
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 24 * 3_600_000);
    expect(rendered?.subject).toBe('Confirm your Acme account');
    expect(rendered?.text).toContain('enter the password chosen when signing up');
    expect(rendered?.text).toContain('for 24 hours');
    expect(signUpConfirmationTemplate.limited).toBe(true);
  });

  it.each([
    ['a malformed payload', message({ payload: {} }), txWith()],
    ['a sign-up replaced or confirmed since', message(), txWith({ signUp: null })],
    [
      'a sign-up of another address',
      message(),
      txWith({ signUp: { id: SIGN_UP_ID, email: 'bob@example.test' } }),
    ],
    ['an address that got an account meanwhile', message(), txWith({ user: { id: 'u1' } })],
  ])('sends nothing for %s', async (_case, claimed, { tx, client }) => {
    await expect(
      signUpConfirmationTemplate.compose({ tx: client, message: claimed, ...context }),
    ).resolves.toBeNull();
    expect(tx.signUp.update).not.toHaveBeenCalled();
  });
});

describe('the notice to an existing account', () => {
  const existing = (overrides: Partial<ClaimedMessage> = {}) =>
    message({ kind: 'sign_up_existing', userId: 'u1', payload: {}, ...overrides });

  it('tells the owner, with the way in and no token', async () => {
    const { client } = txWith({ user: { email: 'ada@example.test' } });
    const rendered = await signUpExistingTemplate.compose({
      tx: client,
      message: existing(),
      ...context,
    });
    expect(rendered?.subject).toBe('Your Acme account already exists');
    expect(rendered?.text).toContain('No new account was created.');
    expect(rendered?.text).toContain('https://app.acme.test/app/sign-in');
    expect(rendered?.text).not.toMatch(/token=/);
    expect(signUpExistingTemplate.limited).toBe(true);
  });

  it('tells nobody once the account is gone or moved to another address', async () => {
    for (const user of [null, { email: 'new@example.test' }]) {
      const { client } = txWith({ user });
      await expect(
        signUpExistingTemplate.compose({ tx: client, message: existing(), ...context }),
      ).resolves.toBeNull();
    }
    const { client } = txWith();
    await expect(
      signUpExistingTemplate.compose({
        tx: client,
        message: existing({ userId: null }),
        ...context,
      }),
    ).resolves.toBeNull();
  });
});

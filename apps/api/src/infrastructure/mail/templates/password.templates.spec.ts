import { describe, expect, it, vi } from 'vitest';
import { hashAccountToken } from '../../../auth/account-tokens.js';
import type { Prisma } from '../../../prisma/generated/client.js';
import type { ClaimedMessage } from '../mail.types.js';
import { passwordChangedTemplate } from './password-changed.template.js';
import { passwordResetTemplate } from './password-reset.template.js';

const message = (overrides: Partial<ClaimedMessage> = {}): ClaimedMessage => ({
  id: 'm1',
  kind: 'password_reset',
  recipient: 'ada@example.test',
  userId: 'u1',
  payload: {},
  attempts: 1,
  attemptsBase: 0,
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  requestId: null,
  ...overrides,
});

function txWith(user: Record<string, unknown> | null) {
  const tx = {
    // The account's lock, taken before a token is minted.
    $queryRaw: vi.fn(() => Promise.resolve([])),
    user: { findUnique: vi.fn(() => Promise.resolve(user)) },
    accountToken: {
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
      create: vi.fn(() => Promise.resolve({})),
    },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}

const context = { product: 'Acme', appUrl: 'https://app.acme.test/app' };

describe('the password reset message', () => {
  it('mints its token when it is sent, puts it after # in a link to the configured origin, stores only its hash', async () => {
    const { tx, client } = txWith({ id: 'u1', email: 'ada@example.test', securityVersion: 4 });
    const rendered = await passwordResetTemplate.compose({
      tx: client,
      message: message(),
      ...context,
    });
    const link = /https:\/\/app\.acme\.test\/app\/reset-password#token=([A-Za-z0-9_-]{43})/.exec(
      rendered?.text ?? '',
    );
    expect(link).not.toBeNull();
    const token = link?.[1] ?? '';
    const [[{ data }]] = tx.accountToken.create.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ];
    expect(data).toMatchObject({
      userId: 'u1',
      purpose: 'password_reset',
      tokenHash: hashAccountToken(token),
      securityVersion: 4,
      email: 'ada@example.test',
    });
    expect(rendered?.subject).toBe('Reset your Acme password');
    expect(rendered?.text).toContain('for 30 minutes');
    expect(rendered?.html).toContain(`#token=${token}`);
    expect(passwordResetTemplate.limited).toBe(true);
  });

  it('sends no link to an account that is gone, or whose email changed since it was asked', async () => {
    for (const user of [null, { id: 'u1', email: 'new@example.test', securityVersion: 4 }]) {
      const { tx, client } = txWith(user);
      await expect(
        passwordResetTemplate.compose({ tx: client, message: message(), ...context }),
      ).resolves.toBeNull();
      expect(tx.accountToken.create).not.toHaveBeenCalled();
    }
    const { client } = txWith(null);
    await expect(
      passwordResetTemplate.compose({ tx: client, message: message({ userId: null }), ...context }),
    ).resolves.toBeNull();
  });
});

describe('the password changed notice', () => {
  const changed = (payload: unknown) => message({ kind: 'password_changed', payload });

  it('says when and how, and how to take the account back, without any secret', async () => {
    const { client } = txWith({ id: 'u1' });
    const viaReset = await passwordChangedTemplate.compose({
      tx: client,
      message: changed({ changedAt: '2026-10-13T10:05:00.000Z', via: 'reset' }),
      ...context,
    });
    expect(viaReset?.subject).toBe('Your Acme password was changed');
    expect(viaReset?.text).toContain('on 2026-10-13 10:05:00 UTC');
    expect(viaReset?.text).toContain('Every session of the account was signed out.');
    expect(viaReset?.text).toContain('https://app.acme.test/app/forgot-password');
    expect(viaReset?.text).not.toMatch(/token=/);
    const viaChange = await passwordChangedTemplate.compose({
      tx: client,
      message: changed({ changedAt: '2026-10-13T10:05:00.000Z', via: 'change' }),
      ...context,
    });
    expect(viaChange?.text).toContain('Every other session of the account was signed out.');
    expect(passwordChangedTemplate.limited).toBe(false);
  });

  it('still tells the owner with a malformed payload, and nobody once the account is gone', async () => {
    const { client } = txWith({ id: 'u1' });
    const rendered = await passwordChangedTemplate.compose({
      tx: client,
      message: changed({ nonsense: true }),
      ...context,
    });
    expect(rendered?.text).toContain('was changed just now');
    const gone = txWith(null);
    await expect(
      passwordChangedTemplate.compose({ tx: gone.client, message: changed({}), ...context }),
    ).resolves.toBeNull();
    await expect(
      passwordChangedTemplate.compose({
        tx: gone.client,
        message: message({ kind: 'password_changed', userId: null }),
        ...context,
      }),
    ).resolves.toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { hashAccountToken } from '../../../auth/account-tokens.js';
import type { Prisma } from '../../../prisma/generated/client.js';
import type { ClaimedMessage } from '../mail.types.js';
import { emailChangeConfirmationTemplate } from './email-change-confirmation.template.js';
import { emailChangeExistingTemplate } from './email-change-existing.template.js';
import { emailChangedTemplate } from './email-changed.template.js';

const message = (overrides: Partial<ClaimedMessage> = {}): ClaimedMessage => ({
  id: 'm1',
  kind: 'email_change_confirmation',
  recipient: 'new@example.test',
  userId: 'u1',
  payload: {},
  attempts: 1,
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  requestId: null,
  ...overrides,
});

interface Rows {
  /** The account of the message (by id); null: gone. */
  user?: Record<string, unknown> | null;
  /** The account at the recipient's address (by email); null: none. */
  owner?: { id: string } | null;
  /** The message's own row as the template reads it under the lock. */
  row?: { status: string } | null;
}

function txWith({
  user = { id: 'u1', email: 'ada@example.test', securityVersion: 3 },
  owner = null,
  row = { status: 'sending' },
}: Rows = {}) {
  const tx = {
    // The account's lock, taken before a token is minted.
    $queryRaw: vi.fn(() => Promise.resolve([])),
    user: {
      findUnique: vi.fn((args: { where: { id?: string } }) =>
        Promise.resolve(args.where.id === undefined ? owner : user),
      ),
    },
    accountToken: {
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
      create: vi.fn(() => Promise.resolve({})),
    },
    mailMessage: {
      findUnique: vi.fn(() => Promise.resolve(row)),
    },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}

const context = { product: 'Acme', appUrl: 'https://app.acme.test/app' };

function createdToken(tx: ReturnType<typeof txWith>['tx']) {
  const [[{ data }]] = tx.accountToken.create.mock.calls as unknown as [
    [{ data: Record<string, unknown> }],
  ];
  return data;
}

describe('the confirmation of a new address', () => {
  it('mints its token at send time for the new address, bound to the account as it is', async () => {
    const { tx, client } = txWith();
    const rendered = await emailChangeConfirmationTemplate.compose({
      tx: client,
      message: message(),
      ...context,
    });
    const token =
      /https:\/\/app\.acme\.test\/app\/confirm-email-change#token=([A-Za-z0-9_-]{43})/.exec(
        rendered?.text ?? '',
      )?.[1];
    expect(createdToken(tx)).toMatchObject({
      userId: 'u1',
      purpose: 'email_change',
      tokenHash: hashAccountToken(token ?? ''),
      securityVersion: 3,
      email: 'ada@example.test',
      targetEmail: 'new@example.test',
    });
    // The account's earlier change links stop working.
    expect(tx.accountToken.deleteMany).toHaveBeenCalledOnce();
    expect(rendered?.subject).toBe('Confirm your new Acme address');
    expect(rendered?.text).toContain('until then nothing changes');
    expect(emailChangeConfirmationTemplate.limited).toBe(true);
  });

  it('sends the link while the account is as it was when the change was asked for', async () => {
    const { tx, client } = txWith();
    const rendered = await emailChangeConfirmationTemplate.compose({
      tx: client,
      message: message({ payload: { securityVersion: '3' } }),
      ...context,
    });
    expect(rendered?.text).toContain('/confirm-email-change#token=');
    expect(createdToken(tx)).toMatchObject({ securityVersion: 3 });
  });

  it.each([
    ['an account that is gone', txWith({ user: null }), message()],
    ['an account already at the address', txWith(), message({ recipient: 'ada@example.test' })],
    ['an address that got an account meanwhile', txWith({ owner: { id: 'u2' } }), message()],
    ['a message without an account', txWith(), message({ userId: null })],
    [
      'an account changed since it was asked for (a password change in between)',
      txWith(),
      message({ payload: { securityVersion: '2' } }),
    ],
  ])('sends nothing for %s', async (_case, { tx, client }, claimed) => {
    await expect(
      emailChangeConfirmationTemplate.compose({ tx: client, message: claimed, ...context }),
    ).resolves.toBeNull();
    expect(tx.accountToken.create).not.toHaveBeenCalled();
  });
});

describe('the notice to an address that has an account', () => {
  const existing = (overrides: Partial<ClaimedMessage> = {}) =>
    message({
      kind: 'email_change_existing',
      recipient: 'taken@example.test',
      userId: 'u2',
      ...overrides,
    });

  it('tells its owner, with nothing to act on', async () => {
    const { client } = txWith({ user: { email: 'taken@example.test' } });
    const rendered = await emailChangeExistingTemplate.compose({
      tx: client,
      message: existing(),
      ...context,
    });
    expect(rendered?.subject).toBe('Your Acme address was not changed');
    expect(rendered?.text).toContain('Nothing was changed.');
    expect(rendered?.text).not.toMatch(/token=|https:/);
    expect(emailChangeExistingTemplate.limited).toBe(true);
  });

  it('tells nobody once that account is gone or moved', async () => {
    for (const user of [null, { email: 'elsewhere@example.test' }]) {
      const { client } = txWith({ user });
      await expect(
        emailChangeExistingTemplate.compose({ tx: client, message: existing(), ...context }),
      ).resolves.toBeNull();
    }
    const { client } = txWith();
    await expect(
      emailChangeExistingTemplate.compose({
        tx: client,
        message: existing({ userId: null }),
        ...context,
      }),
    ).resolves.toBeNull();
  });
});

describe('the notice to the previous address', () => {
  const changed = (payload: unknown = { changedAt: '2026-10-13T10:05:00.000Z' }) =>
    message({ kind: 'email_changed', recipient: 'ada@example.test', payload });

  it('says when and where to, masked, with an undo link that no later change can void', async () => {
    const { tx, client } = txWith({
      user: { id: 'u1', email: 'new.address@example.test', securityVersion: 4 },
    });
    const rendered = await emailChangedTemplate.compose({
      tx: client,
      message: changed(),
      ...context,
    });
    expect(rendered?.subject).toBe('Your Acme address was changed');
    expect(rendered?.text).toContain(
      'on 2026-10-13 10:05:00 UTC, from this one to n•••@example.test',
    );
    expect(rendered?.text).not.toContain('new.address@example.test');
    const token =
      /https:\/\/app\.acme\.test\/app\/revert-email-change#token=([A-Za-z0-9_-]{43})/.exec(
        rendered?.text ?? '',
      )?.[1];
    expect(createdToken(tx)).toMatchObject({
      purpose: 'email_revert',
      tokenHash: hashAccountToken(token ?? ''),
      email: 'new.address@example.test',
      targetEmail: 'ada@example.test',
    });
    // Earlier undo links keep working.
    expect(tx.accountToken.deleteMany).not.toHaveBeenCalled();
    // Queued by the previous release (no securityVersion): ranked as it did.
    expect(createdToken(tx)).toMatchObject({ securityVersion: 4 });
    expect(rendered?.text).toContain('for 7 days');
    expect(emailChangedTemplate.limited).toBe(false);
  });

  it('ranks its undo link by the change it undoes, not by when it goes out', async () => {
    // Sent after later changes raised the account to 9 (retries, an outage).
    const { tx, client } = txWith({
      user: { id: 'u1', email: 'thief@example.test', securityVersion: 9 },
    });
    await emailChangedTemplate.compose({
      tx: client,
      message: changed({ changedAt: '2026-10-13T10:05:00.000Z', securityVersion: '4' }),
      ...context,
    });
    expect(createdToken(tx)).toMatchObject({ purpose: 'email_revert', securityVersion: 4 });
  });

  it('sends no undo link once an undo dropped this notice while it was being composed', async () => {
    const { tx, client } = txWith({
      user: { id: 'u1', email: 'ada@example.test', securityVersion: 9 },
      row: { status: 'expired' },
    });
    await expect(
      emailChangedTemplate.compose({
        tx: client,
        message: message({
          kind: 'email_changed',
          recipient: 'first@example.test',
          payload: { changedAt: '2026-10-13T10:05:00.000Z', securityVersion: '5' },
        }),
        ...context,
      }),
    ).resolves.toBeNull();
    // Its own row, read once the account's lock is held (the undo holds it).
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.mailMessage.findUnique.mock.invocationCallOrder[0] ?? 0,
    );
    expect(tx.mailMessage.findUnique).toHaveBeenCalledWith({
      where: { id: 'm1' },
      select: { status: true },
    });
    expect(tx.accountToken.create).not.toHaveBeenCalled();
  });

  it('still mints for a change made after an earlier one was undone', async () => {
    // The undo is history: this notice's row was queued after it, still sending.
    const { tx, client } = txWith({
      user: { id: 'u1', email: 'third@example.test', securityVersion: 3 },
    });
    await emailChangedTemplate.compose({
      tx: client,
      message: changed({ changedAt: '2026-10-13T10:05:00.000Z', securityVersion: '3' }),
      ...context,
    });
    expect(createdToken(tx)).toMatchObject({ purpose: 'email_revert', securityVersion: 3 });
  });

  it('still tells with a malformed payload, and nobody once undone or gone', async () => {
    const { client } = txWith({
      user: { id: 'u1', email: 'new@example.test', securityVersion: 4 },
    });
    const rendered = await emailChangedTemplate.compose({
      tx: client,
      message: changed({ nonsense: true }),
      ...context,
    });
    expect(rendered?.text).toContain('was changed just now');
    for (const user of [null, { id: 'u1', email: 'ada@example.test', securityVersion: 5 }]) {
      const { tx, client: gone } = txWith({ user });
      await expect(
        emailChangedTemplate.compose({ tx: gone, message: changed(), ...context }),
      ).resolves.toBeNull();
      expect(tx.accountToken.create).not.toHaveBeenCalled();
    }
    const { client: none } = txWith();
    await expect(
      emailChangedTemplate.compose({
        tx: none,
        message: message({ kind: 'email_changed', userId: null }),
        ...context,
      }),
    ).resolves.toBeNull();
  });
});

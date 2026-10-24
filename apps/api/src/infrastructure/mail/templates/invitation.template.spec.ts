import { describe, expect, it, vi } from 'vitest';
import { hashAccountToken } from '../../../auth/account-tokens.js';
import type { Prisma } from '../../../prisma/generated/client.js';
import type { ClaimedMessage } from '../mail.types.js';
import { invitationTemplate } from './invitation.template.js';

const INVITATION_ID = '0190b6a1-0000-7000-8000-0000000000bb';

const message = (overrides: Partial<ClaimedMessage> = {}): ClaimedMessage => ({
  id: 'm1',
  kind: 'invitation',
  recipient: 'ada@example.test',
  userId: null,
  payload: { invitationId: INVITATION_ID },
  attempts: 1,
  claimId: 'claim-1',
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  requestId: null,
  ...overrides,
});

interface Rows {
  invitation?: { id: string; email: string; role: string } | null;
  user?: { id: string } | null;
}

function txWith({
  invitation = { id: INVITATION_ID, email: 'ada@example.test', role: 'member' },
  user = null,
}: Rows = {}) {
  const tx = {
    invitation: {
      findUnique: vi.fn(() => Promise.resolve(invitation)),
      update: vi.fn(() => Promise.resolve({})),
    },
    user: { findUnique: vi.fn(() => Promise.resolve(user)) },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}

const context = { product: 'Acme', appUrl: 'https://app.acme.test/app' };

describe('the invitation message', () => {
  it('mints its token when it is sent, after # in a link to the configured origin, only its hash stored', async () => {
    const { tx, client } = txWith();
    const before = Date.now();
    const rendered = await invitationTemplate.compose({
      tx: client,
      message: message(),
      ...context,
    });
    const token =
      /https:\/\/app\.acme\.test\/app\/accept-invitation#token=([A-Za-z0-9_-]{43})/.exec(
        rendered?.text ?? '',
      )?.[1];
    expect(token).toBeDefined();
    const [[{ where, data }]] = tx.invitation.update.mock.calls as unknown as [
      [{ where: unknown; data: { tokenHash: string; expiresAt: Date } }],
    ];
    expect(where).toEqual({ id: INVITATION_ID });
    expect(data.tokenHash).toBe(hashAccountToken(token ?? ''));
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    expect(rendered?.subject).toBe('You are invited to Acme');
    expect(rendered?.text).toContain('(role: member)');
    expect(rendered?.text).toContain('for 7 days');
    expect(invitationTemplate.limited).toBe(true);
  });

  it.each([
    ['a malformed payload', message({ payload: {} }), txWith()],
    ['an invitation replaced, revoked or accepted', message(), txWith({ invitation: null })],
    [
      'an invitation of another address',
      message(),
      txWith({ invitation: { id: INVITATION_ID, email: 'bob@example.test', role: 'member' } }),
    ],
    ['an address that got an account meanwhile', message(), txWith({ user: { id: 'u1' } })],
  ])('sends nothing for %s', async (_case, claimed, { tx, client }) => {
    await expect(
      invitationTemplate.compose({ tx: client, message: claimed, ...context }),
    ).resolves.toBeNull();
    expect(tx.invitation.update).not.toHaveBeenCalled();
  });
});

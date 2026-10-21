import { z } from 'zod';
import { hashAccountToken, newAccountToken } from '../../../auth/account-tokens.js';
import { INVITATION_MESSAGE_TTL_MS, INVITATION_TTL_MS } from '../../../auth/auth.constants.js';
import { renderMail } from './layout.js';
import type { MailTemplate } from './registry.js';

/** The invitation the message carries (invitations/invitations.service.ts). */
export const InvitationPayloadSchema = z.object({ invitationId: z.uuid() });
export type InvitationPayload = z.infer<typeof InvitationPayloadSchema>;

// An administrator's invitation. The link's token is minted here, when the
// message is sent, and only its hash is stored on the invitation; one
// replaced since (invited again) or revoked, or an address that got an
// account meanwhile, sends nothing. Limited per address like every link.
export const invitationTemplate: MailTemplate = {
  limited: true,
  ttlMs: INVITATION_MESSAGE_TTL_MS,
  async compose({ tx, message, product, appUrl }) {
    const payload = InvitationPayloadSchema.safeParse(message.payload);
    if (!payload.success) return null;
    const invitation = await tx.invitation.findUnique({
      where: { id: payload.data.invitationId },
      select: { id: true, email: true, role: true },
    });
    if (invitation?.email !== message.recipient) return null;
    const account = await tx.user.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });
    if (account !== null) return null;
    const token = newAccountToken();
    await tx.invitation.update({
      where: { id: invitation.id },
      data: {
        tokenHash: hashAccountToken(token),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    });
    return renderMail(
      {
        subject: `You are invited to ${product}`,
        heading: `You are invited to ${product}`,
        paragraphs: [
          `An administrator of ${product} invited this address to create an account (role: ${invitation.role}).`,
          `Open the link below to choose your name and password. It works once, for ${String(INVITATION_TTL_MS / 86_400_000)} days.`,
        ],
        action: {
          label: 'Accept the invitation',
          url: `${appUrl}/accept-invitation#token=${token}`,
        },
        footer: [
          'If you did not expect this, ignore this message: no account is created unless the link is used.',
        ],
      },
      product,
    );
  },
};

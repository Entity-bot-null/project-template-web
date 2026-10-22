import { z } from 'zod';
import { mintAccountToken } from '../../../auth/account-tokens.js';
import { EMAIL_CHANGE_TTL_MS } from '../../../auth/auth.constants.js';
import { renderMail } from './layout.js';
import type { MailTemplate } from './registry.js';

/** The account's securityVersion when the change was asked for. */
export const EmailChangeRequestPayloadSchema = z.object({
  securityVersion: z.string().regex(/^\d{1,9}$/),
});
export type EmailChangeRequestPayload = z.infer<typeof EmailChangeRequestPayloadSchema>;

// A change of address, asked for on the Account page with the current
// password (account/email-change.service.ts), is confirmed from the NEW
// address: this message goes there, with a link whose token is minted now
// (only its hash stored), bound to the account as it is (address and
// securityVersion) and to this new address. Nothing changes until it is
// used. A message that waited in the outbox (retries, an outage) while the
// account changed (a password change or reset, another change of address:
// each raises the securityVersion) goes out with no link: that change voids
// the request. An account holder can ask for it for any address: limited
// per address, like the other links.
export const emailChangeConfirmationTemplate: MailTemplate = {
  limited: true,
  ttlMs: EMAIL_CHANGE_TTL_MS,
  async compose({ tx, message, product, appUrl }) {
    if (message.userId === null) return null;
    const user = await tx.user.findUnique({
      where: { id: message.userId },
      select: { id: true, email: true, securityVersion: true },
    });
    // Gone, or already at this address.
    if (user === null || user.email === message.recipient) return null;
    // Changed since it was asked for. A message without the field was queued
    // by the previous release, during a deployment: bound as it is now.
    const requested = EmailChangeRequestPayloadSchema.safeParse(message.payload);
    if (requested.success && Number(requested.data.securityVersion) !== user.securityVersion) {
      return null;
    }
    // The address got an account meanwhile: no link to it.
    const taken = await tx.user.findUnique({
      where: { email: message.recipient },
      select: { id: true },
    });
    if (taken !== null) return null;
    const token = await mintAccountToken(tx, {
      userId: user.id,
      purpose: 'email_change',
      securityVersion: user.securityVersion,
      email: user.email,
      targetEmail: message.recipient,
      ttlMs: EMAIL_CHANGE_TTL_MS,
    });
    return renderMail(
      {
        subject: `Confirm your new ${product} address`,
        heading: 'Confirm your new email address',
        paragraphs: [
          `You asked to use this address for your ${product} account. Confirm it with the button below: until then nothing changes.`,
          `The link works once, for ${String(EMAIL_CHANGE_TTL_MS / 3_600_000)} hours. Once confirmed, every session of the account is signed out: sign in again with this address.`,
        ],
        action: {
          label: 'Use this address',
          url: `${appUrl}/confirm-email-change#token=${token}`,
        },
        footer: [
          'If you did not ask for this, ignore this message: the account stays at its current address.',
        ],
      },
      product,
    );
  },
};

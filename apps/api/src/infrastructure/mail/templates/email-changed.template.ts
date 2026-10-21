import { z } from 'zod';
import { mintAccountToken } from '../../../auth/account-tokens.js';
import { EMAIL_REVERT_TTL_MS } from '../../../auth/auth.constants.js';
import { renderMail } from './layout.js';
import { maskEmail } from './mask-email.js';
import type { MailTemplate } from './registry.js';

/** When the address changed (account/email-change.service.ts). */
export const EmailChangedPayloadSchema = z.object({ changedAt: z.iso.datetime() });
export type EmailChangedPayload = z.infer<typeof EmailChangedPayloadSchema>;

// A security notice to the PREVIOUS address after a change: the person who
// did not make it learns of it there, and gets a link to undo it, valid for
// days. Its token puts this address back and asks for a new password; it is
// minted here, never replaces another one, and is not bound to what happens
// to the account afterwards: whoever took the account can neither change the
// address again nor change the password to void it. Never held back by the
// per-address limits.
export const emailChangedTemplate: MailTemplate = {
  limited: false,
  ttlMs: 24 * 60 * 60_000,
  async compose({ tx, message, product, appUrl }) {
    if (message.userId === null) return null;
    const user = await tx.user.findUnique({
      where: { id: message.userId },
      select: { id: true, email: true, securityVersion: true },
    });
    // Gone, or back at this address already: nothing to undo.
    if (user === null || user.email === message.recipient) return null;
    const payload = EmailChangedPayloadSchema.safeParse(message.payload);
    const when = payload.success
      ? `on ${payload.data.changedAt.replace('T', ' ').replace(/\.\d+Z$|Z$/, '')} UTC`
      : 'just now';
    const token = await mintAccountToken(tx, {
      userId: user.id,
      purpose: 'email_revert',
      securityVersion: user.securityVersion,
      email: user.email,
      targetEmail: message.recipient,
      ttlMs: EMAIL_REVERT_TTL_MS,
      replaceEarlier: false,
    });
    return renderMail(
      {
        subject: `Your ${product} address was changed`,
        heading: 'Your email address was changed',
        paragraphs: [
          `The address of your ${product} account was changed ${when}, from this one to ${maskEmail(user.email)}. Every session of the account was signed out.`,
          `If you did not do it, undo it with the button below: this address comes back, you choose a new password, and every session is signed out again. The link works for ${String(EMAIL_REVERT_TTL_MS / 86_400_000)} days.`,
        ],
        action: {
          label: 'Not you? Undo this change',
          url: `${appUrl}/revert-email-change#token=${token}`,
        },
        footer: ['If you made this change, there is nothing to do.'],
      },
      product,
    );
  },
};

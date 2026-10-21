import { z } from 'zod';
import { renderMail } from './layout.js';
import type { MailTemplate } from './registry.js';

/** What the message is about: queued with the change (auth/password-reset.service.ts, account/). */
export const PasswordChangedPayloadSchema = z.object({
  /** When the password changed, ISO 8601. */
  changedAt: z.iso.datetime(),
  /** A reset link (every session ended) or a change while signed in (the others ended). */
  via: z.enum(['reset', 'change']),
});
export type PasswordChangedPayload = z.infer<typeof PasswordChangedPayloadSchema>;

// A security notice to the account's address after its password changed: a
// person who did not do it learns it, and how to take the account back. It
// carries no secret (its link is the public "forgot password" page), and is
// never held back by the per-address limits.
export const passwordChangedTemplate: MailTemplate = {
  limited: false,
  ttlMs: 24 * 60 * 60_000,
  async compose({ tx, message, product, appUrl }) {
    if (message.userId === null) return null;
    const user = await tx.user.findUnique({ where: { id: message.userId }, select: { id: true } });
    if (user === null) return null;
    const payload = PasswordChangedPayloadSchema.safeParse(message.payload);
    const when = payload.success
      ? `on ${payload.data.changedAt.replace('T', ' ').replace(/\.\d+Z$|Z$/, '')} UTC`
      : 'just now';
    const sessions =
      payload.success && payload.data.via === 'change'
        ? 'Every other session of the account was signed out.'
        : 'Every session of the account was signed out.';
    return renderMail(
      {
        subject: `Your ${product} password was changed`,
        heading: 'Your password was changed',
        paragraphs: [`The password of your ${product} account was changed ${when}.`, sessions],
        action: { label: 'Not you? Reset your password', url: `${appUrl}/forgot-password` },
        footer: [
          'If you made this change, there is nothing to do.',
          'If you did not, reset your password with the button above right away, then review your account.',
        ],
      },
      product,
    );
  },
};

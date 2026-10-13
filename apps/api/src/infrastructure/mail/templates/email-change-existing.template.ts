import { renderMail } from './layout.js';
import type { MailTemplate } from './registry.js';

// Someone asked to move their account to an address that already has one
// (account/email-change.service.ts). They are answered as for any address,
// so whether it has an account is never told to them; its owner learns of
// the attempt instead. No token, nothing to act on. Limited per address.
export const emailChangeExistingTemplate: MailTemplate = {
  limited: true,
  ttlMs: 24 * 60 * 60_000,
  async compose({ tx, message, product }) {
    if (message.userId === null) return null;
    const owner = await tx.user.findUnique({
      where: { id: message.userId },
      select: { email: true },
    });
    // Gone, or no longer at this address: nothing to tell.
    if (owner?.email !== message.recipient) return null;
    return renderMail(
      {
        subject: `Your ${product} address was not changed`,
        heading: 'This address already has an account',
        paragraphs: [
          `Someone asked to move another ${product} account to this address, which already has an account: yours. Nothing was changed.`,
        ],
        footer: ['There is nothing to do. Your account and its address are unchanged.'],
      },
      product,
    );
  },
};

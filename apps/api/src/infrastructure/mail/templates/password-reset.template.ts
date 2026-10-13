import { mintAccountToken } from '../../../auth/account-tokens.js';
import { PASSWORD_RESET_TTL_MS } from '../../../auth/auth.constants.js';
import { renderMail } from './layout.js';
import type { MailTemplate } from './registry.js';

// "Forgot your password?" (auth/password-reset.service.ts). The link's token
// is minted here, when the message is sent, and only its hash is stored; it
// replaces any earlier reset link of the account. The token travels after #:
// a browser never sends that part to a server, so it reaches no server log.
// Anyone can ask for this message, for any address: limited per address.
export const passwordResetTemplate: MailTemplate = {
  limited: true,
  ttlMs: PASSWORD_RESET_TTL_MS,
  async compose({ tx, message, product, appOrigin }) {
    if (message.userId === null) return null;
    const user = await tx.user.findUnique({
      where: { id: message.userId },
      select: { id: true, email: true, securityVersion: true },
    });
    // Gone, or no longer at this address: no link goes out.
    if (user?.email !== message.recipient) return null;
    const token = await mintAccountToken(tx, {
      userId: user.id,
      purpose: 'password_reset',
      securityVersion: user.securityVersion,
      email: user.email,
      ttlMs: PASSWORD_RESET_TTL_MS,
    });
    return renderMail(
      {
        subject: `Reset your ${product} password`,
        heading: 'Reset your password',
        paragraphs: [
          `Someone asked to reset the password of the ${product} account for this address.`,
          `Choose a new password with the button below. The link works once, for ${String(PASSWORD_RESET_TTL_MS / 60_000)} minutes; asking again replaces it.`,
        ],
        action: {
          label: 'Choose a new password',
          url: `${appOrigin}/reset-password#token=${token}`,
        },
        footer: ['If you did not ask for this, ignore this message: your password stays as it is.'],
      },
      product,
    );
  },
};

import { renderMail } from './layout.js';
import type { MailTemplate } from './registry.js';

// Someone signed up with an address that already has an account
// (auth/sign-up.service.ts). The sign-up answers the same as for a new
// address, so whether an account exists is never told to the person asking;
// the owner learns it instead, with the way in. No token, no link that
// changes anything. Anyone can cause it, for any address: limited per address.
export const signUpExistingTemplate: MailTemplate = {
  limited: true,
  ttlMs: 24 * 60 * 60_000,
  async compose({ tx, message, product, appOrigin }) {
    if (message.userId === null) return null;
    const user = await tx.user.findUnique({
      where: { id: message.userId },
      select: { email: true },
    });
    // Gone, or no longer at this address: nothing to tell.
    if (user?.email !== message.recipient) return null;
    return renderMail(
      {
        subject: `Your ${product} account already exists`,
        heading: 'You already have an account',
        paragraphs: [
          `Someone tried to create an account on ${product} with this address, which already has one. No new account was created.`,
          'To get in, sign in with your password; if you forgot it, choose "Forgot your password?" on the sign-in page.',
        ],
        action: { label: 'Sign in', url: `${appOrigin}/sign-in` },
        footer: ['If you did not try to sign up, ignore this message: your account is unchanged.'],
      },
      product,
    );
  },
};

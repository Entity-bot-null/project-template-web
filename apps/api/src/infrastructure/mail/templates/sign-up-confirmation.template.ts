import { z } from 'zod';
import { hashAccountToken, newAccountToken } from '../../../auth/account-tokens.js';
import { SIGN_UP_TTL_MS } from '../../../auth/auth.constants.js';
import { renderMail } from './layout.js';
import type { MailTemplate } from './registry.js';

/** The sign-up the message confirms (auth/sign-up.service.ts). */
export const SignUpConfirmationPayloadSchema = z.object({ signUpId: z.uuid() });
export type SignUpConfirmationPayload = z.infer<typeof SignUpConfirmationPayloadSchema>;

// "Create an account" (auth/sign-up.service.ts). The link's token is minted
// here, when the message is sent, and only its hash is stored on the sign-up;
// a sign-up replaced since (a newer one for the address) or an account that
// appeared meanwhile sends nothing. Anyone can ask for this message, for any
// address: limited per address.
export const signUpConfirmationTemplate: MailTemplate = {
  limited: true,
  ttlMs: SIGN_UP_TTL_MS,
  async compose({ tx, message, product, appUrl }) {
    const payload = SignUpConfirmationPayloadSchema.safeParse(message.payload);
    if (!payload.success) return null;
    const signUp = await tx.signUp.findUnique({
      where: { id: payload.data.signUpId },
      select: { id: true, email: true },
    });
    if (signUp?.email !== message.recipient) return null;
    const account = await tx.user.findUnique({
      where: { email: signUp.email },
      select: { id: true },
    });
    if (account !== null) return null;
    const token = newAccountToken();
    await tx.signUp.update({
      where: { id: signUp.id },
      data: {
        tokenHash: hashAccountToken(token),
        expiresAt: new Date(Date.now() + SIGN_UP_TTL_MS),
      },
    });
    return renderMail(
      {
        subject: `Confirm your ${product} account`,
        heading: 'Confirm your email address',
        paragraphs: [
          `Someone asked to create an account on ${product} with this address.`,
          `To finish, open the link below and enter the password chosen when signing up. The link works once, for ${String(SIGN_UP_TTL_MS / 3_600_000)} hours.`,
        ],
        action: {
          label: 'Confirm my account',
          url: `${appUrl}/confirm-sign-up#token=${token}`,
        },
        footer: [
          'If you did not ask for this, ignore this message: no account is created without the password chosen at sign-up.',
        ],
      },
      product,
    );
  },
};

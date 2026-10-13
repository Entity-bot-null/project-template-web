import type { MailKind, Prisma } from '../../../prisma/generated/client.js';
import type { ClaimedMessage, MailOptions } from '../mail.types.js';
import type { RenderedMail } from './layout.js';
import { emailChangeConfirmationTemplate } from './email-change-confirmation.template.js';
import { emailChangeExistingTemplate } from './email-change-existing.template.js';
import { emailChangedTemplate } from './email-changed.template.js';
import { invitationTemplate } from './invitation.template.js';
import { passwordChangedTemplate } from './password-changed.template.js';
import { passwordResetTemplate } from './password-reset.template.js';
import { signUpConfirmationTemplate } from './sign-up-confirmation.template.js';
import { signUpExistingTemplate } from './sign-up-existing.template.js';
import { testTemplate } from './test.template.js';

export interface ComposeContext {
  /** A short transaction of its own: a template may write (mint a link's token) before the message leaves. */
  tx: Prisma.TransactionClient;
  message: ClaimedMessage;
  /** The product's name, as messages call it (productName). */
  product: string;
  /** Where links point: the configured public origin, never a request's Host. */
  appOrigin: string;
}

export interface MailTemplate {
  /** Counts against the per-address limits: anyone can make the request that sends it. */
  limited: boolean;
  /** How long a queued message stays worth sending; past it, it is dropped. */
  ttlMs: number;
  /** Renders the message when it is sent; null when it no longer applies (it is dropped). */
  compose(context: ComposeContext): Promise<RenderedMail | null>;
}

export type MailTemplates = Readonly<Record<MailKind, MailTemplate>>;

export const MAIL_TEMPLATE_REGISTRY: MailTemplates = {
  test: testTemplate,
  password_reset: passwordResetTemplate,
  password_changed: passwordChangedTemplate,
  sign_up_confirmation: signUpConfirmationTemplate,
  sign_up_existing: signUpExistingTemplate,
  email_change_confirmation: emailChangeConfirmationTemplate,
  email_change_existing: emailChangeExistingTemplate,
  email_changed: emailChangedTemplate,
  invitation: invitationTemplate,
};

/** What messages call the product: the sender's display name, else the public host. */
export function productName(options: Pick<MailOptions, 'from' | 'appOrigin'>): string {
  if (options.from?.name !== undefined) return options.from.name;
  if (options.appOrigin !== undefined) return new URL(options.appOrigin).host;
  return 'the app';
}

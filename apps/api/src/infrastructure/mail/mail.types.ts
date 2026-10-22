import type { MailKind } from '../../prisma/generated/client.js';

export interface MailAddress {
  address: string;
  name?: string;
}

/** The mail infrastructure's settings: from the environment by default (tests override MAIL_OPTIONS). */
export interface MailOptions {
  /** The SMTP server (MAIL_SMTP_URL); undefined: email is off. */
  smtpUrl: string | undefined;
  from: MailAddress | undefined;
  /** The public origin links in messages point to (APP_ORIGIN). */
  appOrigin: string | undefined;
  /** Where the web app is served under that origin (APP_BASE_PATH): /app, or / at the root. */
  appBasePath: string;
  maxAttempts: number;
  dailyLimitPerAddress: number;
  /** Production refuses an unencrypted connection: STARTTLS is required on smtp://. */
  production: boolean;
  /** Keys the recipient hashes (mail.recipient.ts). */
  recipientKey: Buffer;
}

/** A rendered message on its way to the SMTP server. Only ever in memory. */
export interface OutgoingMail {
  /** The outbox row's id, sent as the Message-ID's local part. */
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** A message the worker claimed: the row as the claim returned it. */
export interface ClaimedMessage {
  id: string;
  kind: MailKind;
  recipient: string;
  userId: string | null;
  payload: unknown;
  /** Attempts started, this one included (a manual retry starts them again). */
  attempts: number;
  /** This claim's own id: with `attempts`, it fences what the worker may record. */
  claimId: string;
  expiresAt: Date;
  createdAt: Date;
  requestId: string | null;
}

import nodemailer from 'nodemailer';
import { isLoopbackHost } from '../../common/utils/loopback.js';
import {
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_GREETING_TIMEOUT_MS,
  SMTP_SOCKET_TIMEOUT_MS,
} from './mail.constants.js';
import type { MailAddress, MailOptions, OutgoingMail } from './mail.types.js';

/** Hands one message to the SMTP server; throws what the server or the connection answered. */
export interface MailTransport {
  send(mail: OutgoingMail): Promise<void>;
  close(): void;
}

export type MailTransportFactory = (options: MailOptions) => MailTransport;

/** nodemailer's settings for MAIL_SMTP_URL; exported for its spec. */
export function smtpSettings(smtpUrl: string, production: boolean) {
  const url = new URL(smtpUrl);
  const secure = url.protocol === 'smtps:';
  return {
    // An IPv6 literal keeps its brackets in a URL, not in a socket address.
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port === '' ? (secure ? 465 : 587) : Number(url.port),
    // smtps: TLS from the first byte. smtp: STARTTLS when the server offers it,
    // and in production only then: an unencrypted server is refused, unless
    // it is on this machine (a loopback host), where nothing crosses a network.
    secure,
    requireTLS: production && !secure && !isLoopbackHost(url.hostname),
    ...(url.username === ''
      ? {}
      : {
          auth: {
            user: decodeURIComponent(url.username),
            pass: decodeURIComponent(url.password),
          },
        }),
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    tls: { minVersion: 'TLSv1.2' as const },
    // A message is built from our templates only, but nodemailer could also
    // read a file or fetch a URL named in it: never let it.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/** The Message-ID domain: the sender's, so receivers see one consistent origin. */
function messageIdDomain(from: MailAddress): string {
  return from.address.slice(from.address.lastIndexOf('@') + 1);
}

export const createSmtpTransport: MailTransportFactory = (options) => {
  const { smtpUrl, from } = options;
  if (smtpUrl === undefined || from === undefined) {
    throw new Error('Email is not configured: MAIL_SMTP_URL and MAIL_FROM are required');
  }
  const transporter = nodemailer.createTransport(smtpSettings(smtpUrl, options.production));
  return {
    async send(mail) {
      await transporter.sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // Stable across retries of one outbox message: a receiver that saw
        // the first copy can tell a duplicate (SMTP is at least once).
        messageId: `<${mail.id}@${messageIdDomain(from)}>`,
        headers: {
          // RFC 3834: automatic, so out-of-office replies are not sent back.
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
        },
      });
    },
    close() {
      transporter.close();
    },
  };
};

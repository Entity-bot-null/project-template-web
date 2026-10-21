import { Global, Module } from '@nestjs/common';
import { env } from '../../env/env.js';
import { MailOutboxService } from './mail-outbox.service.js';
import { MailWorker } from './mail-worker.service.js';
import { MAIL_OPTIONS, MAIL_TEMPLATES, MAIL_TRANSPORT_FACTORY } from './mail.constants.js';
import { deriveRecipientKey } from './mail.recipient.js';
import { MailStore } from './mail.store.js';
import { createSmtpTransport } from './mail.transport.js';
import type { MailOptions } from './mail.types.js';
import { MAIL_TEMPLATE_REGISTRY } from './templates/registry.js';

/** The settings from the environment; the CLI builds the same. */
export function mailOptionsFromEnv(): MailOptions {
  return {
    smtpUrl: env.MAIL_SMTP_URL,
    from: env.MAIL_FROM,
    appOrigin: env.APP_ORIGIN,
    appBasePath: env.APP_BASE_PATH,
    maxAttempts: env.MAIL_MAX_ATTEMPTS,
    dailyLimitPerAddress: env.MAIL_DAILY_LIMIT_PER_ADDRESS,
    production: env.NODE_ENV === 'production',
    recipientKey: deriveRecipientKey(env.JWT_ACCESS_SECRET),
  };
}

// Always imported: without MAIL_SMTP_URL the outbox queues nothing, the worker
// never starts and readiness reports email "disabled". Global, so a feature
// module queues messages without importing anything.
@Global()
@Module({
  providers: [
    { provide: MAIL_OPTIONS, useFactory: mailOptionsFromEnv },
    { provide: MAIL_TRANSPORT_FACTORY, useValue: createSmtpTransport },
    { provide: MAIL_TEMPLATES, useValue: MAIL_TEMPLATE_REGISTRY },
    MailStore,
    MailOutboxService,
    MailWorker,
  ],
  exports: [MailOutboxService, MailWorker],
})
export class MailModule {}

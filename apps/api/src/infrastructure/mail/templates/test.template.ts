import { renderMail } from './layout.js';
import type { MailTemplate } from './registry.js';

// The operator's delivery check (pnpm --filter api mail test --to <address>):
// proves the SMTP settings, the sender and the worker together. Sent on an
// operator's request only, so it is not held back by the per-address limits.
export const testTemplate: MailTemplate = {
  limited: false,
  ttlMs: 60 * 60_000,
  compose({ message, product }) {
    return Promise.resolve(
      renderMail(
        {
          subject: `Test message from ${product}`,
          heading: 'Email delivery works',
          paragraphs: [
            `This message was sent by ${product} to check that it can deliver email.`,
            `Message id: ${message.id}. Queued at ${message.createdAt.toISOString()}.`,
          ],
          footer: [
            'An operator sent this test. If you did not expect it, you can ignore it: nothing was changed.',
          ],
        },
        product,
      ),
    );
  },
};

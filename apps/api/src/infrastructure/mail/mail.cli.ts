import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../../env/env.js';
import { type MailKind, PrismaClient } from '../../prisma/generated/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { MailOutboxService } from './mail-outbox.service.js';
import { mailOptionsFromEnv } from './mail.module.js';
import { recipientHash } from './mail.recipient.js';
import { MailStore } from './mail.store.js';
import { MAIL_TEMPLATE_REGISTRY } from './templates/registry.js';

// The outbox's operator commands (docs/incident-response.md#16-email-not-delivered).
// Locally (no `--` before the options: pnpm passes it on, and parseArgs refuses it):
//   pnpm --filter api mail test --to you@example.com   queue a test message, wait for its delivery
//   pnpm --filter api mail status [--to <address>]     the queue; one address's messages
//   pnpm --filter api mail retry --id <id> | --failed [--kind <kind>]
// in a deployment, with the API image (docs/deploy-vps.md):
//   docker compose ... run --rm -T api node dist/infrastructure/mail/mail.cli.js status
// The database is the one in DATABASE_URL; messages are sent by the API's
// workers, never by this command. Addresses are never printed: a message is
// named by its id, and --to finds an address's messages by their keyed hash.

const USAGE = `Usage:
  mail test --to <address>                 queue a test message and wait for its delivery
  mail status [--to <address>]             the queue, or one address's recent messages
  mail retry --id <id> | --failed [--kind <kind>]   send failed messages again`;

const WAIT_FOR_DELIVERY_MS = 60_000;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: 'string' },
    id: { type: 'string' },
    kind: { type: 'string' },
    failed: { type: 'boolean', default: false },
  },
});

const options = mailOptionsFromEnv();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const store = new MailStore(prisma as unknown as PrismaService, MAIL_TEMPLATE_REGISTRY);
const kinds = Object.keys(MAIL_TEMPLATE_REGISTRY) as MailKind[];

function fail(message: string): never {
  throw new Error(message);
}

async function sendTest(to: string | undefined): Promise<void> {
  if (to === undefined) fail(`--to is required.\n${USAGE}`);
  const outbox = new MailOutboxService(options, MAIL_TEMPLATE_REGISTRY);
  if (!outbox.enabled) fail('Email is off: set MAIL_SMTP_URL (docs/environment.md).');
  // A key of this run's own finds the row again, whatever the clocks of this
  // machine and the database say.
  const dedupeKey = `cli-test:${randomUUID()}`;
  const result = await prisma.$transaction((tx) =>
    outbox.enqueue(tx, { kind: 'test', to, dedupeKey }),
  );
  if (result !== 'queued') fail(`The test message was not queued (${result}).`);
  const queued = await prisma.mailMessage.findUnique({
    where: { dedupeKey },
    select: { id: true },
  });
  if (queued === null) fail('The test message was queued, then not found.');
  console.log(`Queued test message ${queued.id}; waiting for an API worker to send it...`);
  const deadline = Date.now() + WAIT_FOR_DELIVERY_MS;
  while (Date.now() < deadline) {
    const row = await prisma.mailMessage.findUnique({
      where: { id: queued.id },
      select: { status: true, attempts: true, lastError: true },
    });
    if (row?.status === 'sent') {
      console.log(`Delivered: the SMTP server accepted message ${queued.id}.`);
      return;
    }
    if (row?.status === 'failed' || row?.status === 'expired') {
      fail(`Message ${queued.id} ${row.status}: ${row.lastError ?? 'no reason recorded'}.`);
    }
    if (row?.lastError !== null && row?.lastError !== undefined) {
      console.log(`  attempt ${String(row.attempts)} failed (${row.lastError}); retrying...`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail(
    `Message ${queued.id} is still waiting after ${String(WAIT_FOR_DELIVERY_MS / 1000)} s: is an API instance running (its worker sends)? Check its log and "mail status".`,
  );
}

async function showStatus(to: string | undefined): Promise<void> {
  console.log(`Email is ${options.smtpUrl === undefined ? 'off (MAIL_SMTP_URL unset)' : 'on'}.`);
  if (to !== undefined) {
    const messages = await prisma.mailMessage.findMany({
      where: { recipientHash: recipientHash(options.recipientKey, to) },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        kind: true,
        status: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        sentAt: true,
      },
    });
    console.log(`${String(messages.length)} recent message(s) to that address:`);
    for (const m of messages) {
      console.log(
        `  ${m.createdAt.toISOString()}  ${m.id}  ${m.kind}  ${m.status}  attempts=${String(m.attempts)}${m.lastError === null ? '' : `  last error=${m.lastError}`}${m.sentAt === null ? '' : `  sent=${m.sentAt.toISOString()}`}`,
      );
    }
    return;
  }
  const counts = await prisma.mailMessage.groupBy({
    by: ['status', 'kind'],
    _count: { _all: true },
    orderBy: [{ status: 'asc' }, { kind: 'asc' }],
  });
  const { waiting, oldestAgeSeconds } = await store.stats();
  console.log(
    `${String(waiting)} message(s) to send; the oldest waiting for ${String(Math.round(oldestAgeSeconds))} s.`,
  );
  for (const row of counts) {
    console.log(`  ${row.status.padEnd(8)} ${row.kind.padEnd(12)} ${String(row._count._all)}`);
  }
  const failed = await prisma.mailMessage.findMany({
    where: { status: 'failed' },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    select: {
      id: true,
      kind: true,
      attempts: true,
      lastError: true,
      updatedAt: true,
      recipient: true,
    },
  });
  if (failed.length > 0) {
    console.log('Latest failed messages (retry with: mail retry --id <id>):');
    for (const m of failed) {
      console.log(
        `  ${m.updatedAt.toISOString()}  ${m.id}  ${m.kind}  attempts=${String(m.attempts)}  error=${m.lastError ?? '?'}${m.recipient === null ? '  (address cleared: cannot be retried)' : ''}`,
      );
    }
  }
}

async function retry(): Promise<void> {
  const kind = values.kind;
  if (kind !== undefined && !kinds.includes(kind as MailKind)) {
    fail(`Unknown kind "${kind}"; one of: ${kinds.join(', ')}.`);
  }
  if (values.id === undefined && !values.failed) fail(`--id or --failed is required.\n${USAGE}`);
  const count = await store.retryFailed({
    ...(values.id === undefined ? {} : { id: values.id }),
    ...(kind === undefined ? {} : { kind: kind as MailKind }),
  });
  // One message was named: not finding it (a typo, or one that is not failed
  // or lost its address) is an error, not "0 queued".
  if (values.id !== undefined && count === 0) {
    fail(
      `No failed message ${values.id}${kind === undefined ? '' : ` of kind ${kind}`} that still has its address: see "mail status".`,
    );
  }
  console.log(
    `${String(count)} failed message(s) queued again; an API worker sends them within seconds.`,
  );
}

try {
  switch (positionals[0]) {
    case 'test':
      await sendTest(values.to);
      break;
    case 'status':
      await showStatus(values.to);
      break;
    case 'retry':
      await retry();
      break;
    default:
      fail(USAGE);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

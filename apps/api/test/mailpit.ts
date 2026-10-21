import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { deriveRecipientKey } from '../src/infrastructure/mail/mail.recipient.js';
import type { MailOptions } from '../src/infrastructure/mail/mail.types.js';

// Mailpit for the outbox specs (*.int.spec.ts in src/infrastructure/mail):
// MAIL_TEST_SMTP_URL and MAILPIT_TEST_URL (CI starts a throwaway Mailpit),
// else the local one `pnpm dev` starts (MAIL_SMTP_URL in apps/api/.env, its
// web API on MAILPIT_UI_PORT, 8035 by default). Every spec writes to
// addresses of its own and reads and deletes only those, so a development
// Mailpit is safe to use; its chaos switch is global, and the specs that arm
// it disarm it when they finish.
//
// No Mailpit: the specs are skipped locally (email is optional), but fail in
// CI, where skipping would hide a broken outbox.

function fromFile(path: string, name: string): string | undefined {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8'))[name] : undefined;
}

const smtpUrl = process.env.MAIL_TEST_SMTP_URL ?? fromFile('.env', 'MAIL_SMTP_URL');
const apiUrl =
  process.env.MAILPIT_TEST_URL ??
  `http://localhost:${fromFile('../../.env', 'MAILPIT_UI_PORT') ?? '8035'}`;

/** describe.skipIf(skipWithoutMailpit) */
export const skipWithoutMailpit = smtpUrl === undefined && process.env.CI !== 'true';

/** An SMTP server no one listens on: connection refused at once. */
export const UNREACHABLE_SMTP_URL = 'smtp://127.0.0.1:1';

/** A fresh address only this test writes to and reads. */
export function testAddress(): string {
  return `it-${randomUUID()}@example.test`;
}

/** MailOptions for a spec: the test Mailpit, links to a fixed origin. */
export function mailTestOptions(overrides: Partial<MailOptions> = {}): MailOptions {
  if (smtpUrl === undefined) {
    throw new Error(
      'No Mailpit for the integration specs: set MAIL_TEST_SMTP_URL, or MAIL_SMTP_URL in apps/api/.env (pnpm services:up).',
    );
  }
  return {
    smtpUrl,
    from: { name: 'Integration', address: 'no-reply@example.test' },
    appOrigin: 'https://app.example.com',
    appBasePath: '/app',
    maxAttempts: 8,
    dailyLimitPerAddress: 10,
    production: false,
    recipientKey: deriveRecipientKey('integration-only-secret-not-for-real-use-'.padEnd(64, '0')),
    ...overrides,
  };
}

export interface MailpitMessage {
  ID: string;
  MessageID: string;
  Subject: string;
  To: { Address: string }[];
  From: { Address: string; Name: string };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, init);
  if (!response.ok) throw new Error(`Mailpit ${path}: ${String(response.status)}`);
  return (response.headers.get('content-type') ?? '').includes('json')
    ? ((await response.json()) as T)
    : (undefined as T);
}

/** Every message Mailpit holds for `address`, newest first. */
export async function messagesTo(address: string): Promise<MailpitMessage[]> {
  const query = encodeURIComponent(`to:"${address}"`);
  const { messages } = await api<{ messages: MailpitMessage[] }>(`/api/v1/search?query=${query}`);
  return messages;
}

/** The message's headers and plain-text body. */
export async function readMessage(
  id: string,
): Promise<{ text: string; headers: Record<string, string[]> }> {
  const [message, headers] = await Promise.all([
    api<{ Text: string }>(`/api/v1/message/${id}`),
    api<Record<string, string[]>>(`/api/v1/message/${id}/headers`),
  ]);
  return { text: message.Text, headers };
}

export async function deleteMessagesTo(address: string): Promise<void> {
  const query = encodeURIComponent(`to:"${address}"`);
  await api(`/api/v1/search?query=${query}`, { method: 'DELETE' });
}

/** Mailpit answers RCPT TO with this code (451: try later, 550: refused) until disarmed. */
export async function failRecipients(errorCode: number): Promise<void> {
  await chaos({ Recipient: { ErrorCode: errorCode, Probability: 100 } });
}

export async function disarmChaos(): Promise<void> {
  const off = { ErrorCode: 0, Probability: 0 };
  await chaos({ Sender: off, Recipient: off, Authentication: off });
}

async function chaos(triggers: Record<string, { ErrorCode: number; Probability: number }>) {
  await api('/api/v1/chaos', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(triggers),
  });
}

import { expect } from '@playwright/test';
import { e2eMailpit } from '../../apps/api/scripts/e2e-env.mjs';

// The Mailpit the suite's API sends to (apps/api/scripts/e2e-env.mjs). Every
// spec writes to addresses of its own and reads and deletes only those, so a
// development Mailpit is safe to use.

const mailpit = e2eMailpit();

/** test.skip(withoutMailpit, ...): no Mailpit locally means email is off. */
export const withoutMailpit = mailpit === undefined;

interface Message {
  ID: string;
  Subject: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (mailpit === undefined) throw new Error('No Mailpit for the end-to-end suite');
  const response = await fetch(`${mailpit.apiUrl}${path}`, init);
  if (!response.ok) throw new Error(`Mailpit ${path}: ${String(response.status)}`);
  return (response.headers.get('content-type') ?? '').includes('json')
    ? ((await response.json()) as T)
    : (undefined as T);
}

const search = (address: string) => `/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`;

/** Every message Mailpit holds for `address`, newest first. */
export async function messagesTo(address: string): Promise<Message[]> {
  return (await api<{ messages: Message[] }>(search(address))).messages;
}

/** Waits for the message with `subject` sent to `address`; returns its plain text. */
export async function waitForMessage(address: string, subject: string): Promise<string> {
  let found: Message | undefined;
  await expect
    .poll(
      async () => {
        found = (await messagesTo(address)).find((message) => message.Subject === subject);
        return found !== undefined;
      },
      { timeout: 20_000, message: `"${subject}" to ${address}` },
    )
    .toBe(true);
  return (await api<{ Text: string }>(`/api/v1/message/${found?.ID ?? ''}`)).Text;
}

export async function deleteMessagesTo(address: string): Promise<void> {
  if (mailpit !== undefined) await api(search(address), { method: 'DELETE' });
}

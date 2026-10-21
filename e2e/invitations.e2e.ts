import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures.js';
import { deleteMessagesTo, waitForMessage, withoutMailpit } from './support/mailpit.js';

// Invitations in a real browser, with the real message (Mailpit): an
// administrator invites, the person accepts with their own name and password.

// The development administrator created by the API seed (apps/api/src/seed/seed.ts).
const ADMIN = { email: 'admin@example.com', password: 'admin-password' };
const PASSWORD = 'quiet orchard compass 42';
const ACCEPT_LINK = /http:\/\/localhost:4173\/app\/accept-invitation#token=[A-Za-z0-9_-]{43}/;
const addresses: string[] = [];

test.afterEach(async () => {
  for (const email of addresses.splice(0)) await deleteMessagesTo(email);
});

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/app/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('with email', () => {
  test.skip(withoutMailpit, 'No Mailpit: email is off (pnpm services:up starts one)');

  test('an administrator invites; the person accepts with their own name and password, with the chosen role', async ({
    page,
  }) => {
    const email = `e2e-${randomUUID()}@example.test`;
    addresses.push(email);
    await signIn(page, ADMIN.email, ADMIN.password);
    await expect(page.getByRole('heading', { name: 'Welcome, Admin' })).toBeVisible();
    await page.getByRole('link', { name: 'Invitations' }).click();
    const form = page.getByRole('form', { name: 'Invite someone' });
    await form.getByLabel('Email').fill(email);
    await form.getByLabel('Role').selectOption('admin');
    await form.getByRole('button', { name: 'Send invitation' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `Invitation sent to ${email}.` }),
    ).toBeVisible();
    await expect(page.getByRole('cell', { name: email, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);

    const link = ACCEPT_LINK.exec(await waitForMessage(email, 'You are invited to App'))?.[0];
    expect(link, 'the invitation link in the message').toBeDefined();
    await page.goto(link ?? '');
    await expect(page.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible();
    await expect(page).toHaveURL(/\/accept-invitation$/);
    await page.getByLabel('Name').fill('Annie Easley');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create my account' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome, Annie Easley' })).toBeVisible();
    // The role the administrator chose.
    await expect(page.getByRole('link', { name: 'Users' })).toBeVisible();
  });
});

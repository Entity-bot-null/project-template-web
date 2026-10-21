import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { type Account, createAccount } from './support/accounts.js';
import { expect, test } from './support/fixtures.js';
import { deleteMessagesTo, waitForMessage, withoutMailpit } from './support/mailpit.js';

// "Create an account" in a real browser, with the real messages (Mailpit):
// no account until the emailed link is confirmed with the chosen password.

const PASSWORD = 'quiet orchard compass 42';
const addresses: string[] = [];

function newAddress(): string {
  const email = `e2e-${randomUUID()}@example.test`;
  addresses.push(email);
  return email;
}

test.afterEach(async () => {
  for (const email of addresses.splice(0)) await deleteMessagesTo(email);
});

async function signUp(page: Page, email: string, name = 'Katherine Johnson') {
  await page.goto('/app/sign-in');
  await page.getByRole('link', { name: 'Create an account' }).click();
  // Loaded when opened: the sign-in page stays on screen until it is.
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

async function confirmationLink(email: string): Promise<string> {
  const text = await waitForMessage(email, 'Confirm your App account');
  const link = /http:\/\/localhost:4173\/app\/confirm-sign-up#token=[A-Za-z0-9_-]{43}/.exec(
    text,
  )?.[0];
  expect(link, 'the confirmation link in the message').toBeDefined();
  return link ?? '';
}

test.describe('with email', () => {
  test.skip(withoutMailpit, 'No Mailpit: email is off (pnpm services:up starts one)');

  test('creates the account with the emailed link and the chosen password, signed in', async ({
    page,
  }) => {
    const email = newAddress();
    await signUp(page, email);
    // No account yet.
    await page.goto('/app/sign-in');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');

    await page.goto(await confirmationLink(email));
    await expect(page.getByRole('heading', { name: 'Confirm your account' })).toBeVisible();
    // The token left the address bar, and the history, at once.
    await expect(page).toHaveURL(/\/confirm-sign-up$/);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Confirm my account' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome, Katherine Johnson' })).toBeVisible();
    // Signed in for real: the session survives a reload.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome, Katherine Johnson' })).toBeVisible();
  });

  test('cannot be finished by whoever opens the link without the chosen password', async ({
    page,
  }) => {
    const email = newAddress();
    await signUp(page, email);
    await page.goto(await confirmationLink(email));
    await page.getByLabel('Password', { exact: true }).fill('violet harbour lantern 7');
    await page.getByRole('button', { name: 'Confirm my account' }).click();
    await expect(
      page.getByText(/This is not the password you chose when signing up\./),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Confirm your account' })).toBeVisible();
  });

  test('tells the owner instead when the address already has an account', async ({ page }) => {
    const owner: Account = createAccount('Dorothy Vaughan');
    addresses.push(owner.email);
    await signUp(page, owner.email, 'Someone Else');
    const text = await waitForMessage(owner.email, 'Your App account already exists');
    expect(text).toContain('No new account was created.');
    expect(text).not.toMatch(/token=/);
  });
});

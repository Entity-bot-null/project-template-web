import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { createAccount } from './support/accounts.js';
import { expect, test } from './support/fixtures.js';
import { deleteMessagesTo, waitForMessage, withoutMailpit } from './support/mailpit.js';

// Changing the address of an account in a real browser, with the real
// messages (Mailpit): confirmed from the new address, undone from the
// previous one with a new password.

const NEW_PASSWORD = 'quiet orchard compass 42';
const addresses: string[] = [];

test.afterEach(async () => {
  for (const email of addresses.splice(0)) await deleteMessagesTo(email);
});

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const CONFIRM_LINK = /http:\/\/localhost:4173\/confirm-email-change#token=[A-Za-z0-9_-]{43}/;
const REVERT_LINK = /http:\/\/localhost:4173\/revert-email-change#token=[A-Za-z0-9_-]{43}/;

function linkIn(text: string, link: RegExp): string {
  const found = link.exec(text)?.[0];
  expect(found, `the ${link.source} link in the message`).toBeDefined();
  return found ?? '';
}

test.describe('with email', () => {
  test.skip(withoutMailpit, 'No Mailpit: email is off (pnpm services:up starts one)');

  test('moves the account with the link sent to the new address, and the previous one undoes it', async ({
    page,
  }) => {
    const ada = createAccount('Mary Jackson');
    const target = `e2e-${randomUUID()}@example.test`;
    addresses.push(ada.email, target);

    await signIn(page, ada.email, ada.password);
    // Signed in once home shows: the redirect from sign-in has landed.
    await expect(page.getByRole('heading', { name: 'Welcome, Mary Jackson' })).toBeVisible();
    await page.getByRole('link', { name: 'Account' }).click();
    const form = page.getByRole('form', { name: 'Change your email' });
    await form.getByLabel('New email').fill(target);
    await form.getByLabel('Current password', { exact: true }).fill(ada.password);
    await form.getByRole('button', { name: 'Change email' }).click();
    await expect(form.getByRole('status')).toContainText(`A link is on its way to ${target}`);

    // From the new address: opening the link changes nothing, the button does.
    await page.goto(
      linkIn(await waitForMessage(target, 'Confirm your new App address'), CONFIRM_LINK),
    );
    await expect(page).toHaveURL(/\/confirm-email-change$/);
    await page.getByRole('button', { name: 'Use this address' }).click();
    await expect(page.getByRole('heading', { name: 'Email address changed' })).toBeVisible();
    await signIn(page, target, ada.password);
    await expect(page.getByRole('heading', { name: 'Welcome, Mary Jackson' })).toBeVisible();

    // From the previous address: undo, with a new password.
    const notice = await waitForMessage(ada.email, 'Your App address was changed');
    await page.goto(linkIn(notice, REVERT_LINK));
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Undo the change' }).click();
    await expect(page.getByRole('heading', { name: 'Your address is back' })).toBeVisible();

    await signIn(page, target, ada.password);
    await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
    await signIn(page, ada.email, NEW_PASSWORD);
    await expect(page.getByRole('heading', { name: 'Welcome, Mary Jackson' })).toBeVisible();
  });
});

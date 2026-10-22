import type { Browser, Page } from '@playwright/test';
import { type Account, createAccount } from './support/accounts.js';
import { expect, test } from './support/fixtures.js';
import { deleteMessagesTo, waitForMessage, withoutMailpit } from './support/mailpit.js';

// Password recovery and change in a real browser, with the real messages
// (Mailpit): the link of the email, the session ends, the notices.

const NEW_PASSWORD = 'quiet orchard compass 42';
const accounts: Account[] = [];

function account(name: string): Account {
  const created = createAccount(name);
  accounts.push(created);
  return created;
}

test.afterEach(async () => {
  for (const { email } of accounts.splice(0)) await deleteMessagesTo(email);
});

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/app/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Another browser of the same person: same client address as the test's own. */
async function signedInPage(
  browser: Browser,
  extraHTTPHeaders: Record<string, string> | undefined,
  user: Account,
) {
  const page = await (await browser.newContext({ extraHTTPHeaders })).newPage();
  await signIn(page, user.email, user.password);
  await expect(page.getByRole('heading', { name: `Welcome, ${user.name}` })).toBeVisible();
  return page;
}

test.describe('with email', () => {
  test.skip(withoutMailpit, 'No Mailpit: email is off (pnpm services:up starts one)');

  test('recovers an account with the emailed link, once, and says so by email', async ({
    page,
  }) => {
    const ada = account('Adeline Byron');
    await page.goto('/app/sign-in');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    // Loaded when opened: the sign-in page stays on screen until it is.
    await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
    await page.getByLabel('Email').fill(ada.email);
    await page.getByRole('button', { name: 'Send the link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    const text = await waitForMessage(ada.email, 'Reset your App password');
    const link = /http:\/\/localhost:4173\/app\/reset-password#token=[A-Za-z0-9_-]{43}/.exec(
      text,
    )?.[0];
    expect(link, 'the reset link in the message').toBeDefined();

    await page.goto(link ?? '');
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    // The token left the address bar, and the history, at once.
    await expect(page).toHaveURL(/\/reset-password$/);
    const field = page.getByLabel('New password', { exact: true });
    await field.fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Show new password' }).click();
    await expect(field).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Save the new password' }).click();
    await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();

    await signIn(page, ada.email, ada.password);
    await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
    await signIn(page, ada.email, NEW_PASSWORD);
    await expect(page.getByRole('heading', { name: `Welcome, ${ada.name}` })).toBeVisible();
    await waitForMessage(ada.email, 'Your App password was changed');

    // The link worked once.
    await page.goto(link ?? '');
    await page.getByLabel('New password', { exact: true }).fill(`${NEW_PASSWORD} again`);
    await page.getByRole('button', { name: 'Save the new password' }).click();
    await expect(page.getByRole('heading', { name: 'This link does not work' })).toBeVisible();
  });

  test('changes the password while signed in: this browser carries on, the other is signed out', async ({
    browser,
    extraHTTPHeaders,
  }) => {
    const grace = account('Grace Hopper');
    const here = await signedInPage(browser, extraHTTPHeaders, grace);
    const elsewhere = await signedInPage(browser, extraHTTPHeaders, grace);

    await here.getByRole('link', { name: 'Account' }).click();
    const form = here.getByRole('form', { name: 'Change your password' });
    await form.getByLabel('Current password', { exact: true }).fill(grace.password);
    await form.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await form.getByRole('button', { name: 'Change password' }).click();
    await expect(form.getByRole('status')).toContainText('Your password was changed.');

    // This browser: still signed in, after a reload too (its new session).
    await here.reload();
    await expect(here.getByRole('heading', { name: 'Your account' })).toBeVisible();
    // The other one: its session ended on the server.
    await elsewhere.reload();
    await expect(elsewhere).toHaveURL(/\/sign-in$/);
    await waitForMessage(grace.email, 'Your App password was changed');
  });
});

// Each answer turns one link on and the other off: the one that shows proves
// the answer was applied, so the missing one is missing because of it.
for (const [label, offers, shown, hidden] of [
  [
    'no recovery where email is off',
    { passwordReset: false, signUp: true },
    'Create an account',
    'Forgot your password?',
  ],
  [
    'no sign-up where it is closed',
    { passwordReset: true, signUp: false },
    'Forgot your password?',
    'Create an account',
  ],
] as const) {
  test(`offers ${label}`, async ({ page }) => {
    await page.route('**/api/auth/capabilities', (route) =>
      route.fulfill({ json: { data: offers, message: 'Operation successful' } }),
    );
    await page.goto('/app/sign-in');
    await expect(page.getByRole('link', { name: shown })).toBeVisible();
    await expect(page.getByRole('link', { name: hidden })).toHaveCount(0);
  });
}

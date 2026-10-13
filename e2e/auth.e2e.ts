import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './support/fixtures.js';

// The development accounts created by the API seed (apps/api/src/seed/seed.ts).
const MEMBER = { email: 'member@example.com', password: 'member-password', name: 'Member' };
const ADMIN = { email: 'admin@example.com', password: 'admin-password', name: 'Admin' };
// The suite runs the API in production mode: the refresh cookie has the
// __Host- prefix, which sibling subdomains cannot forge.
const REFRESH_COOKIE = '__Host-refresh_token';

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function cookieNames(context: BrowserContext): Promise<string[]> {
  return (await context.cookies()).map((cookie) => cookie.name);
}

test('sends anonymous visitors to sign-in', async ({ page }) => {
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('answers wrong credentials with one generic message', async ({ page }) => {
  await signIn(page, { email: MEMBER.email, password: 'not-the-password' });
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
});

test('keeps the session across a reload and ends it on sign-out', async ({ page }) => {
  await signIn(page, MEMBER);
  const welcome = page.getByRole('heading', { name: `Welcome, ${MEMBER.name}` });
  await expect(welcome).toBeVisible();

  // The access token lives in memory only: the reload restores the session
  // from the httpOnly refresh cookie, which page scripts cannot read.
  await page.reload();
  await expect(welcome).toBeVisible();
  expect(await page.evaluate(() => document.cookie)).not.toContain('refresh_token');
  expect(await cookieNames(page.context())).toContain(REFRESH_COOKIE);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  // The server ended the session and the browser dropped both cookies.
  await expect.poll(() => cookieNames(page.context())).not.toContain(REFRESH_COOKIE);
  expect(await cookieNames(page.context())).not.toContain('has_session');
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('signs every open tab out together', async ({ context, page }) => {
  await signIn(page, MEMBER);
  await expect(page.getByRole('heading', { name: `Welcome, ${MEMBER.name}` })).toBeVisible();
  const otherTab = await context.newPage();
  await otherTab.goto('/');
  await expect(otherTab.getByRole('heading', { name: `Welcome, ${MEMBER.name}` })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(otherTab).toHaveURL(/\/sign-in$/);
});

test('keeps members out of the admin area', async ({ page }) => {
  await signIn(page, MEMBER);
  await expect(page.getByRole('heading', { name: `Welcome, ${MEMBER.name}` })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/$/);
});

test('shows admins the list of users', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  await expect(page.getByRole('cell', { name: MEMBER.email })).toBeVisible();
});

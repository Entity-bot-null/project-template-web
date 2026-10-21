import { expect, test } from './support/fixtures.js';
import { LANDING_URL } from './support/landing.js';

// The public site, as built: both languages, what visitors and search engines
// follow, and the way into the app. The landing is static pages; how a
// deployment serves it next to the app and the API is the smoke test's
// (scripts/smoke-test.mjs).
test.use({ baseURL: LANDING_URL });

test('the home page says what this is and leads into the app', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Project template · Your product starts here');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your product starts here.');
  const hero = page.getByRole('region', { name: 'Your product starts here.' });
  await expect(hero.getByRole('link', { name: 'Open the app' })).toHaveAttribute('href', '/app/');
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sign in' }),
  ).toHaveAttribute('href', '/app/sign-in');
  await expect(page.getByRole('heading', { name: 'What is included' })).toBeVisible();
  await expect(page.getByRole('img', { name: /The invitation email/ })).toBeVisible();
});

test('a visitor reads the site in Spanish and comes back to English', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Español' })
    .click();
  await expect(page).toHaveURL(`${LANDING_URL}/es/`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tu producto empieza aquí.');
  await expect(
    page
      .getByRole('region', { name: 'Tu producto empieza aquí.' })
      .getByRole('link', { name: 'Abrir la aplicación' }),
  ).toHaveAttribute('href', '/app/');
  await page
    .getByRole('navigation', { name: 'Principal' })
    .getByRole('link', { name: 'English' })
    .click();
  await expect(page).toHaveURL(`${LANDING_URL}/`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('the first key press offers to skip to the content', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${LANDING_URL}/#content`);
});

test('an unknown address answers 404, kept out of search results, with a way home', async ({
  page,
}) => {
  const response = await page.goto('/no-such-page/');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nothing lives here.');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(page.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute(
    'href',
    '/',
  );
});

test('robots.txt and the sitemap give search engines every page in both languages', async ({
  request,
}) => {
  const robots = await request.get('/robots.txt');
  expect(robots.ok()).toBe(true);
  expect(await robots.text()).toContain(`Sitemap: ${LANDING_URL}/sitemap-index.xml`);
  const sitemap = await (await request.get('/sitemap-0.xml')).text();
  expect(sitemap).toContain(`<loc>${LANDING_URL}/</loc>`);
  expect(sitemap).toContain(`<loc>${LANDING_URL}/es/</loc>`);
  expect(sitemap).toContain(`hreflang="es" href="${LANDING_URL}/es/"`);
  expect(sitemap).not.toContain('404');
});

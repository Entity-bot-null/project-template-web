import type { APIContext } from 'astro';
import { describe, expect, it } from 'vitest';
// The endpoint is tested from here: a spec under src/pages would become a page.
import { GET } from '../pages/robots.txt';
import { robotsTxt } from './robots';

const EXPECTED = [
  'User-agent: *',
  'Disallow: /app/',
  'Disallow: /api/',
  '',
  'Sitemap: https://example.com/sitemap-index.xml',
  '',
].join('\n');

describe('robotsTxt', () => {
  it('keeps crawlers out of the app and the API, and names the absolute sitemap', () => {
    expect(robotsTxt(new URL('https://example.com'))).toBe(EXPECTED);
  });
});

describe('GET /robots.txt', () => {
  const call = (site: URL | undefined) => GET({ site } as unknown as APIContext);

  it('answers plain text for the site of the build', async () => {
    const response = await call(new URL('https://example.com'));
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe(EXPECTED);
  });

  it('refuses to build without the site address', () => {
    expect(() => call(undefined)).toThrow(/needs the site address/);
  });
});

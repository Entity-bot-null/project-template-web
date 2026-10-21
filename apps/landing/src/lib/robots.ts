/**
 * robots.txt: crawlers read the public pages and find them all in the
 * sitemap; the app's screens (behind a sign-in) and the API are not for them.
 */
export function robotsTxt(site: URL): string {
  return [
    'User-agent: *',
    'Disallow: /app/',
    'Disallow: /api/',
    '',
    `Sitemap: ${new URL('/sitemap-index.xml', site).href}`,
    '',
  ].join('\n');
}

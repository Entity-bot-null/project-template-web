// The languages of the site. The default one lives at the root (/), each
// other one under its code (/es/). astro.config.mjs reads this file too, so
// routing, the sitemap and the pages always agree on the list.
export const LOCALES = ['en', 'es'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

import { en } from './en';
import { es } from './es';
import { DEFAULT_LOCALE, LOCALES, type Locale } from './locales';
import type { Messages } from './messages';

export { DEFAULT_LOCALE, isLocale, LOCALES, type Locale } from './locales';
export type { Capability, Messages, TwoLines } from './messages';

const DICTIONARIES: Readonly<Record<Locale, Messages>> = { en, es };

/** Every text of the site in one language. */
export function messages(locale: Locale): Messages {
  return DICTIONARIES[locale];
}

/**
 * The address of a page in one language: the default language at the root,
 * the others under their code. `path` is the page's address in the default
 * language, from the root and ending in a slash ('/', '/pricing/'), the form
 * the built folders (pricing/index.html) answer to without a redirect.
 */
export function localePath(locale: Locale, path = '/'): string {
  if (!path.startsWith('/') || !path.endsWith('/') || path.startsWith('//')) {
    throw new Error(
      `A page path starts and ends with one slash, such as "/" or "/pricing/": "${path}"`,
    );
  }
  return locale === DEFAULT_LOCALE ? path : `/${locale}${path}`;
}

/** An alternate version of a page, as search engines read it (hreflang). */
export interface Alternate {
  readonly hreflang: Locale | 'x-default';
  readonly href: string;
}

/**
 * The page in every language, absolute, plus x-default (the version for a
 * visitor whose language the site does not have: the default language).
 */
export function alternates(path: string, site: URL): Alternate[] {
  return [
    ...LOCALES.map((locale) => ({
      hreflang: locale,
      href: new URL(localePath(locale, path), site).href,
    })),
    { hreflang: 'x-default', href: new URL(localePath(DEFAULT_LOCALE, path), site).href },
  ];
}

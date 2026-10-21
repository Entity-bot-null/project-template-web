import { describe, expect, it } from 'vitest';
import { alternates, DEFAULT_LOCALE, isLocale, localePath, LOCALES, messages } from '.';

/** Every text of a dictionary, with where it lives: home.heading.0, ... */
function texts(value: unknown, at = ''): [string, string][] {
  if (typeof value === 'string') return [[at, value]];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => texts(inner, at ? `${at}.${key}` : key));
}

describe('dictionaries', () => {
  it('has one per language, named in that language', () => {
    expect(LOCALES.map((locale) => messages(locale).languageName)).toEqual(['English', 'Español']);
  });

  it('writes every text in every language, the same set of texts as English', () => {
    const english = texts(messages(DEFAULT_LOCALE)).map(([at]) => at);
    for (const locale of LOCALES) {
      const entries = texts(messages(locale));
      expect(entries.map(([at]) => at)).toEqual(english);
      for (const [at, text] of entries) {
        expect(text.trim(), `${locale}: ${at}`).not.toBe('');
        expect(text, `${locale}: ${at} has stray spaces`).toBe(text.trim());
      }
    }
  });

  it('translates the texts rather than copying English into Spanish', () => {
    const english = new Map(texts(messages('en')));
    const same = texts(messages('es')).filter(([at, text]) => english.get(at) === text);
    expect(same).toEqual([]);
  });
});

describe('isLocale', () => {
  it('accepts the languages of the site and nothing else', () => {
    expect(LOCALES.every(isLocale)).toBe(true);
    for (const value of ['fr', 'EN', '', undefined, null, 1]) expect(isLocale(value)).toBe(false);
  });
});

describe('localePath', () => {
  it('keeps the default language at the root', () => {
    expect(localePath('en')).toBe('/');
    expect(localePath('en', '/pricing/')).toBe('/pricing/');
  });

  it('puts every other language under its code', () => {
    expect(localePath('es')).toBe('/es/');
    expect(localePath('es', '/pricing/')).toBe('/es/pricing/');
  });

  it('refuses a path that does not start and end with one slash', () => {
    for (const path of ['pricing/', '/pricing', '//evil.example/', '']) {
      expect(() => localePath('es', path)).toThrow(/starts and ends with one slash/);
    }
  });
});

describe('alternates', () => {
  it('lists the page in every language, absolute, and the default one as x-default', () => {
    expect(alternates('/pricing/', new URL('https://example.com'))).toEqual([
      { hreflang: 'en', href: 'https://example.com/pricing/' },
      { hreflang: 'es', href: 'https://example.com/es/pricing/' },
      { hreflang: 'x-default', href: 'https://example.com/pricing/' },
    ]);
  });
});

import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import { LOCALES, messages, type Locale } from '../i18n';
import Home from './Home.astro';
import NotFound from './NotFound.astro';

// The pages as the build renders them, for a site at https://example.com.
let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create({ astroConfig: { site: 'https://example.com' } });
});

const render = (component: typeof Home, locale: Locale) =>
  container.renderToString(component, { props: { locale } });

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

describe.each(LOCALES)('the home page in %s', (locale) => {
  const t = messages(locale);
  const own = locale === 'en' ? 'https://example.com/' : `https://example.com/${locale}/`;

  it('is written in its language, with one main heading', async () => {
    const html = await render(Home, locale);
    expect(html).toContain(`<html lang="${locale}">`);
    expect(count(html, /<h1\b/g)).toBe(1);
    expect(html).toContain(t.home.heading[0]);
    expect(html).toContain(t.home.lead);
  });

  it('tells search engines its address and its twin in every language', async () => {
    const html = await render(Home, locale);
    expect(html).toContain(`<link rel="canonical" href="${own}">`);
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://example.com/">');
    expect(html).toContain('<link rel="alternate" hreflang="es" href="https://example.com/es/">');
    expect(html).toContain(
      '<link rel="alternate" hreflang="x-default" href="https://example.com/">',
    );
    expect(html).not.toContain('noindex');
  });

  it('marks its language as the current one and leads into the app', async () => {
    const html = await render(Home, locale);
    expect(html).toContain(`hreflang="${locale}" lang="${locale}" aria-current="true"`);
    expect(html).toContain('href="/app/"');
    expect(html).toContain('href="/app/sign-in"');
  });

  it('describes every picture of the app in its language', async () => {
    const html = await render(Home, locale);
    expect(count(html, /data-ui role="img"/g)).toBe(4);
    for (const label of Object.values(t.gettingIn.pictures)) expect(html).toContain(label);
  });
});

describe.each(LOCALES)('the not-found page in %s', (locale) => {
  it('stays out of search results and leads home in its language', async () => {
    const html = await render(NotFound, locale);
    expect(html).toContain(`<html lang="${locale}">`);
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain('rel="canonical"');
    expect(html).toContain(messages(locale).notFound.action);
    expect(html).toContain(`href="${locale === 'en' ? '/' : `/${locale}/`}" class="button`);
  });
});

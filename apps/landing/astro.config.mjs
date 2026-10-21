// @ts-check
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { DEFAULT_LOCALE, LOCALES } from './src/i18n/locales.ts';

// The public origin of the site: canonical and alternate links, the sitemap,
// robots.txt. An origin only (scheme, host and port), from the environment of
// the build; without it, the address of the dev and preview servers. The web
// image builds with a placeholder its web server replaces with APP_ORIGIN as
// it answers (apps/web/Dockerfile, apps/web/nginx): one image, every
// environment.
const site = process.env.PUBLIC_URL ?? 'http://localhost:4321';
if (!URL.canParse(site) || new URL(site).origin !== site) {
  throw new Error(
    `PUBLIC_URL must be an origin such as https://example.com, without a path or a trailing slash: "${site}"`,
  );
}

// In development this server is the site's single entry, as the web image is
// in production: /app reaches the web app's dev server (its live-reload
// WebSocket too) and /api the API. Both get the Host the browser sent, which
// the API's CSRF guard reads as the page's origin (scripts/dev-proxy.test.mjs).
// An IP for the API, which listens on IPv4 loopback; localhost for the web
// app, which listens wherever localhost resolves.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';
const webTarget = process.env.WEB_PROXY_TARGET ?? 'http://localhost:5173';

export default defineConfig({
  site,
  // Static files only: the web server hands them out as they are, nothing
  // runs per request.
  output: 'static',
  i18n: {
    locales: [...LOCALES],
    defaultLocale: DEFAULT_LOCALE,
    // The default language at the root (/), the others under their code (/es/).
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    sitemap({
      i18n: {
        defaultLocale: DEFAULT_LOCALE,
        locales: Object.fromEntries(LOCALES.map((locale) => [locale, locale])),
      },
      // The not-found pages are for people who mistype an address, not for
      // search engines.
      filter: (page) => !/\/404\/?$/.test(new URL(page).pathname),
    }),
  ],
  // Vector images only, so no image optimizer to install (sharp, skipped in
  // pnpm-workspace.yaml: ignoredOptionalDependencies).
  image: { service: { entrypoint: 'astro/assets/services/noop' } },
  build: {
    // Every stylesheet as a file, never inlined in a <style> tag, so the web
    // server's Content-Security-Policy can allow styles from this origin only.
    inlineStylesheets: 'never',
  },
  server: { port: 4321 },
  vite: {
    plugins: [tailwindcss()],
    server: {
      // The port the box of `pnpm dev` shows (scripts/dev-banner.mjs): fail
      // rather than move to another one.
      strictPort: true,
      // Regular expressions: a string key matches any path with that prefix,
      // /apple-touch-icon.png included.
      proxy: {
        '^/api(/|$)': { target: apiTarget, changeOrigin: false },
        '^/app(/|$)': { target: webTarget, changeOrigin: false, ws: true },
      },
    },
  },
});

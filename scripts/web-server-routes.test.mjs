// Tests of the routes of apps/web/nginx/default.conf.template against the apps
// they serve (`node --test scripts/web-server-routes.test.mjs`): a language of
// the landing, or a screen the API's emails link to, added on one side only
// would answer 404 in production while every other test passes.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

/** @param {string} path from the repository root */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
/** @param {string} path from the repository root */
const exists = (path) => existsSync(new URL(`../${path}`, import.meta.url));

const nginx = read('apps/web/nginx/default.conf.template');

/** The landing's languages (apps/landing/src/i18n/locales.ts): the default one, then the others. */
function landingLanguages() {
  const source = read('apps/landing/src/i18n/locales.ts');
  const list = /export const LOCALES = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
  const all = [...list.matchAll(/'([a-z]{2,3}(?:-[A-Za-z]{2,4})?)'/g)].map((match) => match[1]);
  const fallback = /export const DEFAULT_LOCALE: Locale = '([^']+)'/.exec(source)?.[1];
  assert.ok(fallback !== undefined && all.includes(fallback), 'DEFAULT_LOCALE is one of LOCALES');
  return { fallback, others: all.filter((code) => code !== fallback) };
}

test('an unknown address is answered with the not-found page of its language', () => {
  const { others } = landingLanguages();
  const map = /map \$uri \$landing_not_found \{([^}]*)\}/.exec(nginx)?.[1] ?? '';
  assert.match(map, /^\s*default \/404\.html;$/m);
  const entries = [...map.matchAll(/^\s*~\^\/([^/]+)\/ (\S+);$/gm)].map(([, code, page]) => [
    code,
    page,
  ]);
  assert.deepEqual(
    entries,
    others.map((code) => [code, `/${code}/404/index.html`]),
    'one map line per language of the landing besides the default',
  );
});

test('every language of the landing has its home page and its not-found page', () => {
  const { others } = landingLanguages();
  assert.ok(exists('apps/landing/src/pages/index.astro'));
  assert.ok(exists('apps/landing/src/pages/404.astro'));
  for (const code of others) {
    assert.ok(exists(`apps/landing/src/pages/${code}/index.astro`), `${code}/index.astro`);
    assert.ok(exists(`apps/landing/src/pages/${code}/404.astro`), `${code}/404.astro`);
  }
});

test('the screens emails link to are redirected under /app/, and are screens of the app', () => {
  const redirected =
    /location ~ "\^\/\(([^)]*)\)\/\?\$" \{[^}]*return 301 \/app\/\$1\$is_args\$args;/.exec(
      nginx,
    )?.[1];
  assert.ok(redirected !== undefined, 'the redirect of the old app paths');
  const linked = new Set();
  const templates = 'apps/api/src/infrastructure/mail/templates';
  for (const file of readdirSync(new URL(`../${templates}`, import.meta.url))) {
    if (!file.endsWith('.template.ts')) continue;
    for (const [, screen] of read(`${templates}/${file}`).matchAll(/\$\{appUrl\}\/([a-z-]+)/g)) {
      linked.add(screen);
    }
  }
  assert.deepEqual(redirected.split('|').sort(), [...linked].sort());
  const router = read('apps/web/src/router.tsx');
  for (const screen of linked) assert.match(router, new RegExp(`path="${screen}"`), screen);
});

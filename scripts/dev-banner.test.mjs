// Tests of the `pnpm dev` banner (scripts/dev-banner.mjs). Run: pnpm test:scripts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { DEFAULT_DB_PORT, devSettings, renderBanner } from './dev-banner.mjs';

const APP = { name: 'project-template', version: '1.2.3' };
/** @type {(format: unknown, text: string) => string} */
const plain = (_format, text) => text;

describe('devSettings', () => {
  test('the defaults: API on loopback port 3000, the database without its credentials', () => {
    assert.deepEqual(
      devSettings({
        api: { DATABASE_URL: `postgresql://app:secret@localhost:${DEFAULT_DB_PORT}/app` },
        compose: {},
      }),
      {
        web: 'http://localhost:5173',
        api: 'http://127.0.0.1:3000/api',
        docs: 'http://127.0.0.1:3000/api/docs',
        database: `localhost:${DEFAULT_DB_PORT}/app`,
      },
    );
  });

  test('HOST and PORT of the API are used, an IPv6 host in brackets', () => {
    const settings = devSettings({
      api: { HOST: '::1', PORT: '4000', DATABASE_URL: 'postgresql://db.internal/app' },
      compose: {},
    });
    assert.equal(settings.api, 'http://[::1]:4000/api');
    assert.equal(settings.docs, 'http://[::1]:4000/api/docs');
  });

  test('a local DATABASE_URL on another port than DB_PORT is pointed out', () => {
    const settings = devSettings({
      api: { DATABASE_URL: 'postgresql://app:app@localhost:5433/app' },
      compose: { DB_PORT: '5444' },
    });
    assert.match(
      settings.warning ?? '',
      /DATABASE_URL uses port 5433, but pnpm db:up publishes 5444/,
    );
  });

  test('the same port on both sides, or a remote database, is not', () => {
    for (const [url, dbPort] of [
      ['postgresql://app:app@127.0.0.1:5444/app', '5444'],
      ['postgresql://app:app@db.example.com:5432/app', undefined],
    ]) {
      assert.equal(
        devSettings({ api: { DATABASE_URL: url }, compose: { DB_PORT: dbPort } }).warning,
        undefined,
      );
    }
  });

  test('without DATABASE_URL, it says where to copy it from', () => {
    const settings = devSettings({ api: {}, compose: {} });
    assert.equal(settings.database, undefined);
    assert.match(settings.warning ?? '', /apps\/api\/\.env\.example/);
  });

  test('the default port is the one docker-compose.yml publishes', () => {
    const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
    assert.ok(compose.includes(`'127.0.0.1:\${DB_PORT:-${DEFAULT_DB_PORT}}:5432'`));
    const example = readFileSync(new URL('../apps/api/.env.example', import.meta.url), 'utf8');
    assert.ok(example.includes(`@localhost:${DEFAULT_DB_PORT}/app`));
  });
});

describe('renderBanner', () => {
  const settings = devSettings({
    api: { DATABASE_URL: `postgresql://app:secret@localhost:${DEFAULT_DB_PORT}/app` },
    compose: {},
  });

  test('a closed box with the title and one row per address', () => {
    const lines = renderBanner(settings, APP, plain).split('\n');
    assert.match(lines[0] ?? '', /^ {2}╭─+╮$/);
    assert.match(lines.at(-1) ?? '', /^ {2}╰─+╯$/);
    const text = lines.join('\n');
    assert.match(text, /project-template 1\.2\.3 · development/);
    for (const value of [settings.web, settings.api, settings.docs, settings.database ?? '']) {
      assert.ok(text.includes(value), value);
    }
    assert.ok(!text.includes('secret'));
  });

  test('every line of the box is as wide; a warning goes under it, not inside', () => {
    const box = renderBanner(settings, APP, plain).split('\n');
    assert.equal(new Set(box.map((line) => line.length)).size, 1);
    const warning = 'DATABASE_URL uses port 1, but pnpm db:up publishes 2 '.repeat(3);
    const lines = renderBanner({ ...settings, warning }, APP, plain).split('\n');
    assert.deepEqual(lines.slice(0, box.length), box);
    assert.equal(lines.at(-1), `  !  ${warning}`);
  });

  test('colors wrap the parts, never change the layout', () => {
    /** @type {(format: unknown, text: string) => string} */
    const tagged = (format, text) => `<${String(format)}>${text}</>`;
    const strip = (/** @type {string} */ text) => text.replace(/<[^>]*>/g, '');
    assert.equal(strip(renderBanner(settings, APP, tagged)), renderBanner(settings, APP, plain));
  });
});

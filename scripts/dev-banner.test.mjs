// Tests of the `pnpm dev` banner (scripts/dev-banner.mjs). Run: pnpm test:scripts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { stripVTControlCharacters, styleText } from 'node:util';
import {
  DEFAULT_DB_PORT,
  DEFAULT_MAILPIT_SMTP_PORT,
  DEFAULT_MAILPIT_UI_PORT,
  devSettings,
  renderBanner,
} from './dev-banner.mjs';

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
        mail: 'off (set MAIL_SMTP_URL in apps/api/.env)',
        warnings: [],
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
    assert.equal(settings.warnings.length, 1);
    assert.match(
      settings.warnings[0] ?? '',
      /DATABASE_URL uses port 5433, but pnpm db:up publishes 5444/,
    );
  });

  test('the same port on both sides, or a remote database, is not', () => {
    for (const [url, dbPort] of [
      ['postgresql://app:app@127.0.0.1:5444/app', '5444'],
      ['postgresql://app:app@db.example.com:5432/app', undefined],
    ]) {
      assert.deepEqual(
        devSettings({ api: { DATABASE_URL: url }, compose: { DB_PORT: dbPort } }).warnings,
        [],
      );
    }
  });

  test('without DATABASE_URL, it says where to copy it from', () => {
    const settings = devSettings({ api: {}, compose: {} });
    assert.equal(settings.database, undefined);
    assert.match(settings.warnings[0] ?? '', /apps\/api\/\.env\.example/);
  });

  test('the default ports are the ones docker-compose.yml publishes', () => {
    const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
    assert.ok(compose.includes(`'127.0.0.1:\${DB_PORT:-${DEFAULT_DB_PORT}}:5432'`));
    assert.ok(
      compose.includes(`'127.0.0.1:\${MAILPIT_SMTP_PORT:-${DEFAULT_MAILPIT_SMTP_PORT}}:1025'`),
    );
    assert.ok(compose.includes(`'127.0.0.1:\${MAILPIT_UI_PORT:-${DEFAULT_MAILPIT_UI_PORT}}:8025'`));
    const example = readFileSync(new URL('../apps/api/.env.example', import.meta.url), 'utf8');
    assert.ok(example.includes(`@localhost:${DEFAULT_DB_PORT}/app`));
    assert.ok(example.includes(`MAIL_SMTP_URL=smtp://localhost:${DEFAULT_MAILPIT_SMTP_PORT}`));
  });

  test('mail: the local Mailpit is shown as its web UI, another server by host only', () => {
    const local = devSettings({
      api: { MAIL_SMTP_URL: `smtp://localhost:${DEFAULT_MAILPIT_SMTP_PORT}` },
      compose: {},
    });
    assert.equal(local.mail, `http://localhost:${DEFAULT_MAILPIT_UI_PORT} (Mailpit)`);
    const ports = devSettings({
      api: { MAIL_SMTP_URL: 'smtp://127.0.0.1:2025' },
      compose: { MAILPIT_SMTP_PORT: '2025', MAILPIT_UI_PORT: '9025' },
    });
    assert.equal(ports.mail, 'http://localhost:9025 (Mailpit)');
    const remote = devSettings({
      api: { MAIL_SMTP_URL: 'smtps://user:secret@smtp.example.com:465' },
      compose: {},
    });
    assert.equal(remote.mail, 'smtps://smtp.example.com:465');
    assert.ok(!JSON.stringify(remote).includes('secret'));
  });

  test("mail: a local SMTP port that is not this project's Mailpit is pointed out", () => {
    // The usual case: 1025, the port another project's Mailpit holds.
    const settings = devSettings({
      api: { MAIL_SMTP_URL: 'smtp://localhost:1025' },
      compose: {},
    });
    assert.equal(settings.mail, 'smtp://localhost:1025');
    assert.match(
      settings.warnings.join('\n'),
      /MAIL_SMTP_URL uses port 1025, but pnpm services:up publishes Mailpit on 1035/,
    );
  });

  test('mail: off, or an unreadable URL, is said as much', () => {
    assert.equal(
      devSettings({ api: {}, compose: {} }).mail,
      'off (set MAIL_SMTP_URL in apps/api/.env)',
    );
    assert.equal(
      devSettings({ api: { MAIL_SMTP_URL: 'not a url' }, compose: {} }).mail,
      'invalid MAIL_SMTP_URL',
    );
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
    for (const value of [
      settings.web,
      settings.api,
      settings.docs,
      settings.database ?? '',
      settings.mail,
    ]) {
      assert.ok(text.includes(value), value);
    }
    assert.ok(!text.includes('secret'));
  });

  test("email's state from readiness follows the mail row, except when it is off", () => {
    const withMailpit = devSettings({
      api: { MAIL_SMTP_URL: `smtp://localhost:${DEFAULT_MAILPIT_SMTP_PORT}` },
      compose: {},
    });
    assert.match(
      renderBanner(withMailpit, APP, plain, 'ok'),
      /Mail +http:\/\/localhost:8035 \(Mailpit\) · ok/,
    );
    assert.match(renderBanner(withMailpit, APP, plain, 'degraded'), /· degraded/);
    assert.doesNotMatch(renderBanner(settings, APP, plain, 'disabled'), /· disabled/);
  });

  test('every line of the box is as wide; warnings go under it, not inside', () => {
    const box = renderBanner(settings, APP, plain).split('\n');
    assert.equal(new Set(box.map((line) => line.length)).size, 1);
    const warning = 'DATABASE_URL uses port 1, but pnpm db:up publishes 2 '.repeat(3);
    const lines = renderBanner({ ...settings, warnings: [warning, 'second'] }, APP, plain).split(
      '\n',
    );
    assert.deepEqual(lines.slice(0, box.length), box);
    assert.deepEqual(lines.slice(-2), [`  !  ${warning}`, '  !  second']);
  });

  test('colors wrap the parts, never change the layout', () => {
    // The terminal's own color codes, as on a terminal, whatever runs the test.
    /** @type {(format: Parameters<typeof styleText>[0], text: string) => string} */
    const colored = (format, text) => styleText(format, text, { validateStream: false });
    const output = renderBanner(settings, APP, colored);
    assert.notEqual(output, renderBanner(settings, APP, plain));
    assert.equal(stripVTControlCharacters(output), renderBanner(settings, APP, plain));
  });
});

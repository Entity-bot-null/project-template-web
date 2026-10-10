// Tests of apps/web/nginx/18-validate-runtime-config.sh
// (`node --test scripts/validate-runtime-config.test.mjs`): the real script,
// run with sh as the web image's entrypoint runs it, against valid and invalid
// runtime settings. The values end up inside JSON in nginx's `return 200 '…'`
// (default.conf.template): a newline, a quote, a backslash or a `$` must stop
// the container with the variable's name, never pass.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../apps/web/nginx/18-validate-runtime-config.sh', import.meta.url),
);

/** A POSIX sh: on PATH, or on Windows the one Git ships (the hooks run with it). */
function findShell() {
  if (spawnSync('sh', ['-c', 'exit 0']).status === 0) return 'sh';
  const gitExec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const gitSh = join(gitExec, '..', '..', '..', 'bin', 'sh.exe');
  if (gitExec !== '' && existsSync(gitSh)) return gitSh;
  throw new Error('No POSIX sh found: install one (Git for Windows ships it) to run this test.');
}
const SH = findShell();

/** What the image sets, plus what 15-local-resolvers.envsh exports. */
const VALID = {
  APP_ENVIRONMENT: 'production',
  APP_RELEASE: '3f2c1a9',
  WEB_SENTRY_DSN: '',
  WEB_SENTRY_SAMPLE_RATE: '1',
  WEB_VITALS_SAMPLE_RATE: '1',
  NGINX_LOCAL_RESOLVERS: '127.0.0.11',
};

/** @typedef {keyof typeof VALID} Setting */

/**
 * @param {Partial<Record<Setting, string>>} overrides
 * @returns {{ status: number | null; stderr: string }}
 */
function validate(overrides = {}) {
  const run = spawnSync(SH, [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...VALID, ...overrides },
  });
  assert.equal(run.error, undefined);
  return { status: run.status, stderr: run.stderr };
}

/**
 * @param {Setting} name
 * @param {string} value
 */
function assertRefused(name, value) {
  /** @type {Partial<Record<Setting, string>>} */
  const overrides = { [name]: value };
  const { status, stderr } = validate(overrides);
  assert.equal(status, 1, `${name}=${JSON.stringify(value)} was accepted`);
  assert.ok(stderr.includes(`Environment variable ${name} is invalid`), stderr);
  // The message names the variable, never its value.
  assert.ok(!stderr.includes('evil'), stderr);
}

describe('18-validate-runtime-config.sh', () => {
  test('accepts the image defaults and well-formed values', () => {
    assert.deepEqual(validate(), { status: 0, stderr: '' });
    assert.equal(
      validate({
        APP_ENVIRONMENT: 'staging-eu',
        APP_RELEASE: 'v1.4.0+build.7',
        WEB_SENTRY_DSN: 'https://0123abcd@o42.ingest.sentry.io/4504',
        WEB_SENTRY_SAMPLE_RATE: '0.25',
        WEB_VITALS_SAMPLE_RATE: '0',
      }).status,
      0,
    );
  });

  test('refuses a value with a newline, even when its first line is valid', () => {
    // grep matches line by line: the first line used to carry the rest in.
    assertRefused('APP_RELEASE', 'abc\n"};evil');
    assertRefused('APP_RELEASE', 'abc\n');
    assertRefused('APP_ENVIRONMENT', 'staging\nevil');
    assertRefused('WEB_SENTRY_DSN', 'https://0123abcd@o42.ingest.sentry.io/4504\nevil');
    assertRefused('WEB_SENTRY_SAMPLE_RATE', '1\nevil');
    assertRefused('WEB_VITALS_SAMPLE_RATE', '0.5\nevil');
    assertRefused('APP_RELEASE', 'abc\revil');
  });

  test('refuses quotes, backslashes and $ that would break the JSON or the nginx string', () => {
    for (const character of ['"', "'", '\\', '$']) {
      assertRefused('APP_RELEASE', `abc${character}evil`);
      assertRefused('APP_ENVIRONMENT', `staging${character}evil`);
      assertRefused('WEB_SENTRY_DSN', `https://0123abcd@o42.ingest.sentry.io/4504${character}evil`);
      assertRefused('WEB_SENTRY_SAMPLE_RATE', `1${character}`);
      assertRefused('WEB_VITALS_SAMPLE_RATE', `1${character}`);
    }
  });

  test('refuses values of the wrong shape', () => {
    assertRefused('APP_ENVIRONMENT', 'Production');
    assertRefused('APP_RELEASE', '');
    assertRefused('WEB_SENTRY_DSN', 'http://0123abcd@o42.ingest.sentry.io/4504');
    assertRefused('WEB_SENTRY_SAMPLE_RATE', '1.5');
    assertRefused('WEB_VITALS_SAMPLE_RATE', '');
    assertRefused('WEB_VITALS_SAMPLE_RATE', '2');
    assertRefused('NGINX_LOCAL_RESOLVERS', '');
  });
});

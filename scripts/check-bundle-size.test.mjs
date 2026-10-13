// Tests of scripts/check-bundle-size.mjs: what counts as the initial
// JavaScript, and how budgets pass, fail or match nothing. Run: pnpm test:scripts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkBudgets, initialAssets } from './check-bundle-size.mjs';

// The shape Vite writes: the entry, a chunk it shares with lazy ones, the CSS.
const HTML = `<!doctype html>
<html lang="en">
  <head>
    <script type="module" crossorigin src="/assets/index-D7idpz_K.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/validation-CwNs7JtE.js">
    <link rel="stylesheet" crossorigin href="/assets/index-BmaOGjo5.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

const FILES = [
  'index-D7idpz_K.js',
  'validation-CwNs7JtE.js',
  'index-BmaOGjo5.css',
  'AccountPage-Aqb84nzj.js',
];
const SIZES = new Map([
  ['index-D7idpz_K.js', 70_000],
  ['validation-CwNs7JtE.js', 30_000],
  ['index-BmaOGjo5.css', 600],
  ['AccountPage-Aqb84nzj.js', 1_000],
]);
const build = {
  files: FILES,
  html: HTML,
  gzipBytes: (/** @type {string} */ f) => SIZES.get(f) ?? 0,
};

describe('initialAssets', () => {
  test('is the module script and every chunk it preloads, whatever their names', () => {
    assert.deepEqual(initialAssets(HTML), ['index-D7idpz_K.js', 'validation-CwNs7JtE.js']);
  });

  test('leaves out stylesheets, classic scripts and other origins', () => {
    const html = [
      '<link rel="stylesheet" href="/assets/index-x.css">',
      '<script src="/assets/legacy-x.js"></script>',
      '<script type="module" src="https://cdn.example/app.js"></script>',
      '<link rel="preload" href="/assets/font-x.js">',
    ].join('\n');
    assert.deepEqual(initialAssets(html), []);
  });
});

describe('checkBudgets', () => {
  test('counts a preloaded shared chunk in the initial JavaScript', () => {
    const { lines, failed } = checkBudgets(
      [{ name: 'JavaScript, initial', initial: true, maxGzipKb: 99 }],
      build,
    );
    assert.equal(failed, true);
    assert.equal(
      lines[0]?.line,
      'OVER BUDGET  JavaScript, initial: 100.0 kB gzip, budget 99 kB (2 files)',
    );
  });

  test('passes budgets within their size, by pattern too', () => {
    const { lines, over, failed } = checkBudgets(
      [
        { name: 'JavaScript, initial', initial: true, maxGzipKb: 100 },
        { name: 'Account pages', pattern: /^AccountPage-/, maxGzipKb: 2 },
        { name: 'JavaScript, total', pattern: /\.js$/, maxGzipKb: 101 },
      ],
      build,
    );
    assert.deepEqual(
      lines.map((entry) => entry.ok),
      [true, true, true],
    );
    assert.equal(over, false);
    assert.equal(failed, false);
  });

  test('fails a budget that measures nothing', () => {
    const { lines, over, failed } = checkBudgets(
      [
        { name: 'Renamed', pattern: /^gone-/, maxGzipKb: 5 },
        { name: 'JavaScript, initial', initial: true, maxGzipKb: 100 },
      ],
      { ...build, html: '<html></html>' },
    );
    assert.equal(failed, true);
    assert.equal(over, false);
    assert.match(lines[0]?.line ?? '', /^NO MATCH {2}Renamed: .*fix the pattern "\^gone-"$/);
    assert.match(lines[1]?.line ?? '', /index\.html loads no script from assets\/$/);
  });
});

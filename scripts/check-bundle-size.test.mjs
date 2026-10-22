// Tests of scripts/check-bundle-size.mjs: what counts as the initial
// JavaScript, how budgets pass, fail or match nothing, and what a page may not
// carry under the Content-Security-Policy. Run: pnpm test:scripts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkBudgets, cspProblems, initialAssets } from './check-bundle-size.mjs';

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

  test('reads tags and attributes in any letter case and quoting, as HTML does', () => {
    const html = [
      '<SCRIPT TYPE="module" SRC="/assets/index-a.js"></SCRIPT>',
      "<Link Rel='modulepreload' Href='/assets/shared-b.js'>",
      '<link rel=modulepreload href=/assets/vendor-c.js>',
    ].join('\n');
    assert.deepEqual(initialAssets(html), ['index-a.js', 'shared-b.js', 'vendor-c.js']);
  });

  test('reads the assets folder of an app served under a base path', () => {
    const html = [
      '<script type="module" src="/app/assets/index-a.js"></script>',
      '<link rel="modulepreload" href="/assets/elsewhere-b.js">',
    ].join('\n');
    assert.deepEqual(initialAssets(html, '/app/assets/'), ['index-a.js']);
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

  test('a budget of 0 kB passes when the build has no such asset, and fails on any', () => {
    const none = { name: 'JavaScript, none', pattern: /\.js$/, maxGzipKb: 0 };
    const empty = checkBudgets([none], { files: ['site-a.css'], html: '', gzipBytes: () => 0 });
    assert.equal(empty.failed, false);
    assert.equal(empty.lines[0]?.line, 'ok  JavaScript, none: 0.0 kB gzip, budget 0 kB (0 files)');
    const one = checkBudgets([none], { files: ['tiny-a.js'], html: '', gzipBytes: () => 0 });
    assert.equal(one.failed, true);
    assert.equal(one.over, true);
    assert.match(one.lines[0]?.line ?? '', /^OVER BUDGET {2}JavaScript, none: .*\(1 files\)$/);
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

describe('cspProblems', () => {
  // The shape of a landing page: files of this origin, absolute links that
  // only point somewhere (canonical, alternates), a data: image.
  const PAGE = `<!doctype html><html lang="en"><head>
    <link rel="canonical" href="https://example.com/">
    <link rel="alternate" hreflang="es" href="https://example.com/es/">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="/_astro/Headline.DfKozz_w.css">
    <script type="module" src="/_astro/menu.B1x.js"></script>
    <script type="application/ld+json">{"@type":"WebSite"}</script>
    </head><body><a href="https://github.com/acme">Code</a>
    <img src="data:image/svg+xml,%3Csvg%3E" alt=""><p class="stylesheet">x</p></body></html>`;

  test('passes a page made of files of this origin', () => {
    assert.deepEqual(cspProblems(PAGE), []);
  });

  test('finds what the policy refuses: inline scripts and styles, handlers, other origins', () => {
    const page = `<SCRIPT>document.body.dataset.menu = "ready"</SCRIPT>
      <script type="module">document.documentElement.dataset.x=\`1\`;</script>
      <style>p{color:red}</style>
      <p STYLE='color: red'>x</p>
      <button onclick="go()">Go</button>
      <a href=" javascript:alert(1)">x</a>
      <link rel="preload stylesheet" href="//fonts.example.net/a.css">
      <img src="https://cdn.example.net/a.png" srcset="/a.png 1x, https://cdn.example.net/a@2x.png 2x">
      <script src="data:text/javascript,alert(1)"></script>`;
    assert.deepEqual(cspProblems(page), [
      'an inline script',
      'an inline script',
      'a <style> element',
      'a style attribute on <p>',
      'an inline event handler on <button>',
      'a javascript: URL',
      'a file from another origin: //fonts.example.net/a.css',
      'a file from another origin: https://cdn.example.net/a.png',
      'a file from another origin: https://cdn.example.net/a@2x.png',
      'a file from another origin: data:text/javascript,alert(1)',
    ]);
  });

  test('reads tags as a browser does: quotes, comments and script text', () => {
    // A `>` inside a quoted value (Tailwind's [&>svg]) does not end the tag.
    assert.deepEqual(cspProblems('<div class="[&>svg]:size-4" style="color:red">x</div>'), [
      'a style attribute on <div>',
    ]);
    assert.deepEqual(cspProblems('<img/src="https://cdn.example.net/a.png">'), [
      'a file from another origin: https://cdn.example.net/a.png',
    ]);
    // Text that only looks like markup or attributes.
    assert.deepEqual(
      cspProblems(`<!-- <script>x</script> -->
        <meta name="description" content="Choose a style = yours, get online=fast">
        <p title="x onclick=go()">x</p>
        <script type="application/ld+json ">{"name":"<b style=x>"}</script>`),
      [],
    );
  });

  test('finds forms, objects, bases and SVG files the policy refuses', () => {
    assert.deepEqual(
      cspProblems(`<form action="https://news.example.net/subscribe"><button formaction="//x.example.net/">Go</button></form>
        <object data="/doc.pdf"></object><embed src="/movie.swf">
        <base href="https://cdn.example.net/">
        <svg><use href="//cdn.example.net/s.svg#a"></use><image xlink:href="https://cdn.example.net/i.png"></image></svg>
        <video poster="https://cdn.example.net/p.png"><source src="data:video/mp4;base64,AAAA"></video>`),
      [
        'a form sent to another origin: https://news.example.net/subscribe',
        'a form sent to another origin: //x.example.net/',
        "an <object> (object-src 'none')",
        "an <embed> (object-src 'none')",
        'a <base> pointing elsewhere: https://cdn.example.net/',
        'a file from another origin: //cdn.example.net/s.svg#a',
        'a file from another origin: https://cdn.example.net/i.png',
        'a file from another origin: https://cdn.example.net/p.png',
        'a file from another origin: data:video/mp4;base64,AAAA',
      ],
    );
  });

  test('allows images from data: URLs, as the policy does', () => {
    assert.deepEqual(
      cspProblems(`<link rel="icon" href="data:image/svg+xml,%3Csvg%3E">
        <link rel="preload" as="image" href="data:image/png;base64,AAAA">
        <input type="image" src="data:image/png;base64,AAAA" alt="Go">
        <picture><source srcset="data:image/webp;base64,AAAA"><img src="data:image/png;base64,AAAA" alt=""></picture>`),
      [],
    );
  });
});

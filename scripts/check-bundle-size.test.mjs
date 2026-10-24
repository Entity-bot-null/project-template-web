// Tests of scripts/check-bundle-size.mjs: which files of a build are measured,
// what counts as the initial JavaScript, how budgets pass, fail or match
// nothing, and what a page or a stylesheet may not carry under the
// Content-Security-Policy. Run: pnpm test:scripts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  builtFiles,
  checkBudgets,
  cspProblems,
  cssProblems,
  initialAssets,
} from './check-bundle-size.mjs';

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

describe('initialAssets and module scripts', () => {
  test('counts .mjs entries and preloads like .js ones', () => {
    assert.deepEqual(
      initialAssets(
        '<script type="module" src="/assets/index-a.mjs"></script><link rel="modulepreload" href="/assets/vendor-b.MJS">',
      ),
      ['index-a.mjs', 'vendor-b.MJS'],
    );
  });
});

describe('the command', () => {
  test("measures and reads every file of the builds, the landing's public/ ones and upper-case names included", () => {
    // A copy of the command in a repository of its own: two builds, two budget files.
    const root = mkdtempSync(join(tmpdir(), 'budget-command-'));
    const write = (/** @type {string} */ file, /** @type {string} */ content = '') => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    };
    const run = () =>
      spawnSync(process.execPath, [join(root, 'scripts', 'check-bundle-size.mjs')], {
        encoding: 'utf8',
      });
    try {
      mkdirSync(join(root, 'scripts'));
      copyFileSync(
        fileURLToPath(new URL('check-bundle-size.mjs', import.meta.url)),
        join(root, 'scripts', 'check-bundle-size.mjs'),
      );
      // parse5, found from the copy as from the original.
      symlinkSync(
        fileURLToPath(new URL('../node_modules', import.meta.url)),
        join(root, 'node_modules'),
        'junction',
      );
      write(
        'apps/web/performance-budget.json',
        JSON.stringify({ budgets: [{ name: 'JavaScript', pattern: '\\.m?js$', maxGzipKb: 1 }] }),
      );
      write(
        'apps/web/dist/index.html',
        '<script type="module" src="/app/assets/index-a.js"></script>',
      );
      write('apps/web/dist/assets/index-a.js', 'export {};');
      write(
        'apps/landing/performance-budget.json',
        JSON.stringify({
          budgets: [
            { name: 'JavaScript', pattern: '\\.m?js$', maxGzipKb: 0 },
            { name: 'CSS', pattern: '\\.css$', maxGzipKb: 6 },
          ],
        }),
      );
      write('apps/landing/dist/index.html', '<link rel="stylesheet" href="/_astro/a.css">');
      write('apps/landing/dist/_astro/a.css', '.a{color:red}');
      const clean = run();
      assert.equal(clean.status, 0, clean.stdout + clean.stderr);

      // What public/ copies next to the pages: a script, a stylesheet that
      // imports a font's stylesheet from another site.
      write('apps/landing/dist/vendor/widget.JS', 'console.log(1);');
      write(
        'apps/landing/dist/fonts.css',
        '@import url("https://fonts.example.net/css2?family=Inter");',
      );
      const refused = run();
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /OVER BUDGET {2}JavaScript: .* \(1 files\)/);
      assert.match(
        refused.stderr,
        /REFUSED BY THE CSP {2}fonts\.css: an @import from another origin: https:\/\/fonts\.example\.net\//,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test("measures every file of the build by its name, what public/ put next to the bundler's included", () => {
    // The landing's budgets over its whole build: a script copied from
    // public/ (loaded with <script is:inline src>) is JavaScript all the same.
    const landing = [
      { name: 'JavaScript', pattern: /\.m?js$/, maxGzipKb: 0 },
      { name: 'CSS', pattern: /\.css$/, maxGzipKb: 6 },
    ];
    for (const script of ['js/widget.js', 'widget.mjs']) {
      const { lines, failed } = checkBudgets(landing, {
        files: ['_astro/Headline.a1.css', 'fonts.css', script, 'index.html'],
        html: '',
        gzipBytes: () => 1_000,
        assets: '_astro/',
        assetsPath: '/_astro/',
      });
      assert.equal(failed, true, script);
      assert.deepEqual(
        lines.map((entry) => entry.line),
        [
          'OVER BUDGET  JavaScript: 1.0 kB gzip, budget 0 kB (1 files)',
          'ok  CSS: 2.0 kB gzip, budget 6 kB (2 files)',
        ],
        script,
      );
    }
    // The initial JavaScript is found in the assets folder; patterns read the
    // file's name wherever it is.
    const { lines } = checkBudgets(
      [
        { name: 'JavaScript, initial', initial: true, maxGzipKb: 100 },
        { name: 'Account pages', pattern: /^AccountPage-/, maxGzipKb: 2 },
      ],
      {
        files: [...FILES.map((file) => `assets/${file}`), 'index.html'],
        html: HTML,
        gzipBytes: (file) => SIZES.get(file.replace(/^assets\//, '')) ?? 0,
        assets: 'assets/',
      },
    );
    assert.deepEqual(
      lines.map((entry) => entry.line),
      [
        'ok  JavaScript, initial: 100.0 kB gzip, budget 100 kB (2 files)',
        'ok  Account pages: 1.0 kB gzip, budget 2 kB (1 files)',
      ],
    );
  });
});

describe('builtFiles', () => {
  test("lists every file of a build, in its folders too, as paths from the build's folder", () => {
    const dist = mkdtempSync(join(tmpdir(), 'budget-'));
    try {
      mkdirSync(join(dist, '_astro'));
      mkdirSync(join(dist, 'es', 'fonts'), { recursive: true });
      for (const file of ['index.html', '_astro/Headline.a1.css', 'es/fonts/inter.css', 'w#1.js']) {
        writeFileSync(join(dist, file), '');
      }
      assert.deepEqual(builtFiles(pathToFileURL(`${dist}/`)), [
        '_astro/Headline.a1.css',
        'es/fonts/inter.css',
        'index.html',
        'w#1.js',
      ]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
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

  test('ends comments where a browser does, and reads raw text elements as text', () => {
    // <!--> and <!---> end at once; --!> ends a comment too.
    assert.deepEqual(cspProblems('<!--><script>alert(1)</script><!-- end -->'), [
      'an inline script',
    ]);
    assert.deepEqual(cspProblems('<!---><p style="x">a</p>'), ['a style attribute on <p>']);
    assert.deepEqual(cspProblems('<!-- a --!><p style="x">a</p>'), ['a style attribute on <p>']);
    // Text a browser does not parse as markup, and what follows it is.
    assert.deepEqual(
      cspProblems(
        '<title>Use the <script> tag</title><textarea><!-- </textarea><p style="x">a</p>',
      ),
      ['a style attribute on <p>'],
    );
    // Inside SVG nothing is raw text, and <title/> closes itself; its title is
    // an HTML integration point, so what it holds is read too.
    assert.deepEqual(
      cspProblems('<svg><title/><path d="M0"/></svg><p style="x">a</p><script>alert(1)</script>'),
      ['a style attribute on <p>', 'an inline script'],
    );
    assert.deepEqual(
      cspProblems('<svg><title><img src="https://cdn.example.net/x.png"></title></svg>'),
      ['a file from another origin: https://cdn.example.net/x.png'],
    );
    assert.deepEqual(cspProblems('<math/><title><p style="x"></p></title>'), []);
    // Each foreign element closes by its own end tag; a value's slash closes nothing.
    assert.deepEqual(
      cspProblems('<svg></math><title><img src="https://x.example/a.png"></title></svg>'),
      ['a file from another origin: https://x.example/a.png'],
    );
    assert.deepEqual(
      cspProblems('<svg width=24/><title><img src=https://x.example/a.png></title></svg>'),
      ['a file from another origin: https://x.example/a.png'],
    );
    // CDATA in SVG is text: its </svg> ends nothing.
    assert.deepEqual(
      cspProblems('<svg><![CDATA[</svg>]]><title/><path/></svg><p style="x">a</p>'),
      ['a style attribute on <p>'],
    );
    // Where HTML is read again (integration points, an HTML tag that ends the
    // SVG), a title or a textarea is raw text again.
    for (const page of [
      '<svg><foreignObject><textarea><img src="https://x.example/a.png"></textarea></foreignObject></svg>',
      '<math><mi><title><img src="https://x.example/a.png"></title></mi></math>',
      '<svg><span></span><title><img src="https://x.example/a.png"></title>',
    ]) {
      assert.deepEqual(cspProblems(page), [], page);
    }
    // A letter that changes length in lower case does not shift what is read.
    assert.deepEqual(
      cspProblems(
        `${'İ'.repeat(12)}<script type="application/ld+json">{}</script><script>x</script>`,
      ),
      ['an inline script'],
    );
  });

  test('decodes character references as a browser does, and never stops on a bad one', () => {
    assert.deepEqual(cspProblems('<a title="&#x110000; &#99999999999; &#0;">x</a>'), []);
    assert.deepEqual(
      cspProblems(`<a href="java&Tab;script&colon;alert(1)">x</a>
        <a href="&#x6A;avascript:go()">x</a>
        <a href="java\nscript:go()">x</a>`),
      ['a javascript: URL', 'a javascript: URL', 'a javascript: URL'],
    );
    // Backslashes read as slashes: another origin.
    assert.deepEqual(cspProblems('<img src="\\\\cdn.example.net/a.png" alt="">'), [
      'a file from another origin: \\\\cdn.example.net/a.png',
    ]);
  });

  test('leaves SVG and MathML where a browser does, and reads HTML again where it does', () => {
    const image = 'a file from another origin: https://x.example/a.png';
    /** @type {[string, string[]][]} */
    const pages = [
      // </p> and </br> leave foreign content; CDATA is then a bogus comment.
      ['<svg></p><![CDATA[><script>alert(1)</script>]]>', ['an inline script']],
      ['<svg></br><![CDATA[><img src="https://x.example/a.png">]]>', [image]],
      // An end tag of an HTML element that holds the SVG closes it too.
      ['<div><svg></div><![CDATA[><img src="https://x.example/a.png">]]>', [image]],
      // A math inside an SVG is an SVG element: its title reads HTML again.
      [
        '<svg><math><mi><title><script>alert(1)</script></title></mi></math></svg>',
        ['an inline script'],
      ],
    ];
    for (const [page, found] of pages) {
      assert.deepEqual(cspProblems(page), found, page);
    }
  });

  test("reads a noscript's and a template's content: a browser may show it", () => {
    assert.deepEqual(cspProblems('<noscript><img src="https://x.example/a.png"></noscript>'), [
      'a file from another origin: https://x.example/a.png',
    ]);
    assert.deepEqual(cspProblems('<template><p onclick="go()">x</p></template>'), [
      'an inline event handler on <p>',
    ]);
  });

  test('reads a page as browsers with and without JavaScript do, each problem once', () => {
    // With JavaScript, a <noscript>'s content is text up to </noscript>: the
    // comment ends nothing there, and the script after it runs.
    assert.deepEqual(
      cspProblems('<noscript><!--</noscript><script>alert(1)</script>--></noscript>'),
      ['an inline script'],
    );
    assert.deepEqual(cspProblems('<p><script>alert(1)</script><script>alert(2)</script></p>'), [
      'an inline script',
      'an inline script',
    ]);
  });

  test("finds image candidates of a preload, and what an iframe's srcdoc carries", () => {
    assert.deepEqual(
      cspProblems(`<link rel="preload" as="image" imagesrcset="/a.png 1x, https://cdn.example.net/b.png 2x">
        <iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>`),
      [
        'a file from another origin: https://cdn.example.net/b.png',
        "in an iframe's srcdoc: an inline script",
      ],
    );
  });
});

describe('cssProblems', () => {
  test('passes a stylesheet of this origin, with images from data: URLs', () => {
    assert.deepEqual(
      cssProblems(`@import "/_astro/base.css";
        .a { background: url(data:image/svg+xml,%3Csvg%3E) } .b { background: url('/i.png') }
        /* @import url(https://fonts.example.net/css); */`),
      [],
    );
  });

  test('reads @import rules only outside strings, and comments only outside strings', () => {
    for (const css of [
      '@importer{}.a{background:url(https://evil.example/x.png)}',
      '.a{content:"@import"}.b{background:url(https://evil.example/x.png)}',
      '.a{content:"/*"}.b{background:url(https://evil.example/x.png)}/* */',
    ]) {
      assert.deepEqual(
        cssProblems(css),
        ['a file from another origin: https://evil.example/x.png'],
        css,
      );
    }
  });

  test('ends a string at a line break it does not escape, and reads an escaped quote as no string', () => {
    // A bad string ends at the line break: the next rule is read.
    assert.deepEqual(
      cssProblems("@import 'local.css\n;\n@import url(https://evil.example/x.css);"),
      ['an @import from another origin: https://evil.example/x.css'],
    );
    // An escaped quote starts no string: the comment after it is a comment,
    // and the url() between the two strings is read.
    assert.deepEqual(
      cssProblems(
        ".a\\'{}.b{content:'x'}.c{content:'/*'}.d{background:url(https://evil.example/x.png)}.e{content:'*/'}",
      ),
      ['a file from another origin: https://evil.example/x.png'],
    );
    // An escaped line break goes on with the string, CRLF and CR included
    // (a browser reads both as one line break).
    assert.deepEqual(cssProblems(`.a{content:"a\\\n@import 'https://evil.example/x.css';"}`), []);
    for (const lineBreak of ['\r\n', '\r', '\f']) {
      const css = `.a{content:"x\\${lineBreak}y/*"}.b{background:url(https://evil.example/x.png)}.c{content:"*/"}`;
      assert.deepEqual(
        cssProblems(css),
        ['a file from another origin: https://evil.example/x.png'],
        JSON.stringify(lineBreak),
      );
    }
  });

  test('reads every URL a browser fetches: quoted ones whole, image-set() and image() candidates, escapes', () => {
    const css = [
      '.a{background-image:image-set("https://cdn.example.net/a.png" 1x, url(/b.png) 2x)}',
      ".b{background-image:-webkit-image-set('//cdn.example.net/c.png' 1x)}",
      '.c{background:url("https://cdn.example.net/x(1).png")}',
      '.d{background:URL( "https://cdn.example.net/d.png" )}',
      '.e{background:url(https\\3a //cdn.example.net/e.png)}',
      '.f{background:image("https://cdn.example.net/f.png", red)}',
    ].join('\n');
    assert.deepEqual(cssProblems(css), [
      'a file from another origin: https://cdn.example.net/a.png',
      'a file from another origin: //cdn.example.net/c.png',
      'a file from another origin: https://cdn.example.net/x(1).png',
      'a file from another origin: https://cdn.example.net/d.png',
      'a file from another origin: https://cdn.example.net/e.png',
      'a file from another origin: https://cdn.example.net/f.png',
    ]);
  });

  test('leaves alone what a browser does not fetch: other strings, a bad url(), an @namespace', () => {
    for (const css of [
      '.a{content:"https://cdn.example.net/a.png"}',
      '.a{font-family:"https://cdn.example.net"}.b{background:format("https://x.example/a.woff")}',
      // Bad: a quote or a space inside an unquoted url(); a browser drops the declaration.
      ".a{background:url(https://cdn.example.net/it's.png)}",
      '.a{background:url(https://cdn.example.net/a b.png)}',
      '@namespace svg url(http://www.w3.org/2000/svg);',
      '@charset "utf-8";',
      // A hash is a name (#url is no function); conditions fetch nothing.
      '.a{color:#url(https://cdn.example.net/a.png)}',
      '@supports (background:url(https://cdn.example.net/a.png)){.a{color:red}}',
      '@import url(/base.css) supports(background:url(https://cdn.example.net/a.png));',
      '@import "/base.css" layer(base) screen;',
    ]) {
      assert.deepEqual(cssProblems(css), [], css);
    }
    // What a rule inside a conditional at-rule loads is fetched.
    assert.deepEqual(
      cssProblems('@supports (display:grid){.a{background:url(https://cdn.example.net/a.png)}}'),
      ['a file from another origin: https://cdn.example.net/a.png'],
    );
  });

  test('finds what the policy refuses: other origins, and fonts from data: URLs', () => {
    assert.deepEqual(
      cssProblems(`@import url("https://fonts.example.net/css2?family=Inter");
        @import '//cdn.example.net/x.css';
        @import"https://fonts.example.net/minified.css";
        @font-face { src: url(data:font/woff2;base64,AAAA) format("woff2") }
        .hero { background-image: url( "https://cdn.example.net/hero.jpg" ) }`),
      [
        'an @import from another origin: https://fonts.example.net/css2?family=Inter',
        'an @import from another origin: //cdn.example.net/x.css',
        'an @import from another origin: https://fonts.example.net/minified.css',
        'a data: URL that is not an image',
        'a file from another origin: https://cdn.example.net/hero.jpg',
      ],
    );
  });
});

// Performance budget (docs/testing.md#performance-budget): fails when the
// built assets of an app outgrow its performance-budget.json (the web app's
// and the landing's), or when a page of the landing, or a stylesheet of
// either, carries what the web server's Content-Security-Policy refuses. Sizes are gzip, what browsers
// actually download, in kB of 1000 bytes like Vite reports. Run after
// `pnpm build`; part of `pnpm verify` and CI.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

/**
 * Each app with a budget: its build folder, the folder of hashed assets
 * inside it, that folder's URL path on the site (the web app is served under
 * /app/) and its budget file.
 * `pages`: every HTML page of the build is checked against the CSP too.
 * @type {{ name: string; dist: URL; assets: string; assetsPath: string; budget: URL; pages?: boolean }[]}
 */
const APPS = [
  {
    name: 'web',
    dist: new URL('../apps/web/dist/', import.meta.url),
    assets: 'assets/',
    assetsPath: '/app/assets/',
    budget: new URL('../apps/web/performance-budget.json', import.meta.url),
  },
  {
    name: 'landing',
    dist: new URL('../apps/landing/dist/', import.meta.url),
    assets: '_astro/',
    assetsPath: '/_astro/',
    budget: new URL('../apps/landing/performance-budget.json', import.meta.url),
    pages: true,
  },
];

/** `<link rel>` values that make the browser load the URL, and those that load an image. */
const LOADED_LINKS =
  /^(?:stylesheet|icon|apple-touch-icon|mask-icon|manifest|preload|modulepreload|prefetch)$/i;
const IMAGE_LINKS = /^(?:icon|apple-touch-icon|mask-icon)$/i;

/** Named character references that can spell a URL's scheme or its slashes. */
const NAMED = new Map([
  ['colon', ':'],
  ['tab', '\t'],
  ['newline', '\n'],
  ['sol', '/'],
  ['bsol', '\\'],
  ['period', '.'],
  ['quot', '"'],
  ['apos', "'"],
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
]);

/**
 * A code point as a browser decodes a numeric reference: one out of range,
 * NUL or a surrogate is U+FFFD.
 * @param {number} code
 */
function codePoint(code) {
  const replaced = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
  return String.fromCodePoint(replaced || Number.isNaN(code) ? 0xfffd : code);
}

/**
 * An attribute value with its character references decoded: numeric ones,
 * and the named ones that matter for a URL.
 * @param {string} value
 */
function decoded(value) {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));?/gi,
    (
      /** @type {string} */ reference,
      /** @type {string | undefined} */ hex,
      /** @type {string | undefined} */ dec,
      /** @type {string | undefined} */ named,
    ) => {
      if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
      if (dec !== undefined) return codePoint(Number(dec));
      return NAMED.get((named ?? '').toLowerCase()) ?? reference;
    },
  );
}

/**
 * A URL as a browser reads it: tabs and line breaks dropped wherever they
 * are, leading spaces and control characters too.
 * @param {string} url
 */
function urlOf(url) {
  const kept = url.replace(/[\t\n\r]/g, '');
  let start = 0;
  while (start < kept.length && kept.charCodeAt(start) <= 0x20) start += 1;
  return kept.slice(start);
}

const isJavaScriptUrl = (/** @type {string} */ url) => /^javascript:/i.test(urlOf(url));
// Another origin: a scheme, or two slashes either way (a browser reads a
// backslash as a slash in an http(s) URL).
const isAbsolute = (/** @type {string} */ url) =>
  /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(urlOf(url));

/**
 * Elements whose text a browser does not parse as markup, up to their end
 * tag (`plaintext` has none: the rest of the page is its text).
 */
const RAW_TEXT = new Set([
  'script',
  'style',
  'title',
  'textarea',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
]);

/**
 * Where the end tag `</name` starts from `from` on, in any letter case; the
 * end of the document without one.
 * @param {string} html
 * @param {string} name
 * @param {number} from
 */
function endTag(html, name, from) {
  for (let k = html.indexOf('</', from); k !== -1; k = html.indexOf('</', k + 2)) {
    if (html.slice(k + 2, k + 2 + name.length).toLowerCase() === name) return k;
  }
  return html.length;
}

/** Start tags that end foreign content (svg, math): HTML is read again. */
const BREAKOUT = new Set(
  'b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var'.split(
    ' ',
  ),
);

/**
 * Whether an element of foreign content reads its content as HTML again (an
 * integration point): an SVG foreignObject, desc or title; a MathML text
 * element, or an annotation-xml holding HTML.
 * @param {string | undefined} root 'svg' or 'math'
 * @param {string} name
 * @param {Map<string, string>} attributes
 */
function integrationPoint(root, name, attributes) {
  if (root === 'svg') return name === 'foreignobject' || name === 'desc' || name === 'title';
  if (root !== 'math') return false;
  if (name === 'annotation-xml') {
    return /^(?:text\/html|application\/xhtml\+xml)$/i.test(attributes.get('encoding') ?? '');
  }
  return ['mi', 'mo', 'mn', 'ms', 'mtext'].includes(name);
}

/**
 * Where a comment that starts at `open` (`<!--`) ends, as a browser ends it:
 * `<!-->` and `<!--->` at once, otherwise at the first `-->` or `--!>`.
 * @param {string} html
 * @param {number} open
 */
function commentEnd(html, open) {
  if (html.startsWith('>', open + 4)) return open + 5;
  if (html.startsWith('->', open + 4)) return open + 6;
  const ends = [html.indexOf('-->', open + 4), html.indexOf('--!>', open + 4)].filter(
    (end) => end !== -1,
  );
  if (ends.length === 0) return html.length;
  const end = Math.min(...ends);
  return end + (html.startsWith('--!>', end) ? 4 : 3);
}

/**
 * The tags of an HTML document, read as a browser reads them: a quoted
 * attribute value may hold `>`, comments are skipped (ended where a browser
 * ends them), and the text of a script, a style, a title, a textarea and the
 * other raw text elements is not markup, except inside SVG and MathML, where
 * none is. End tags come as `/name`.
 * @param {string} html
 * @returns {{ name: string; attributes: Map<string, string> }[]}
 */
export function tagsOf(html) {
  /** @type {{ name: string; attributes: Map<string, string> }[]} */
  const tags = [];
  // The open svg and math elements, and the integration points inside them
  // where HTML is read again ('html'), innermost last. In foreign content no
  // element is raw text, <x/> closes itself and CDATA is text.
  /** @type {{ name: string; kind: string }[]} */
  const scopes = [];
  const foreign = () => {
    const kind = scopes.at(-1)?.kind;
    return kind === 'svg' || kind === 'math';
  };
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf('<', i);
    if (open === -1) break;
    if (html.startsWith('<!--', open)) {
      i = commentEnd(html, open);
      continue;
    }
    if (foreign() && html.startsWith('<![CDATA[', open)) {
      const end = html.indexOf(']]>', open + 9);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const start = /^<(\/?)([a-zA-Z][\w:-]*)/.exec(html.slice(open, open + 80));
    if (start === null) {
      i = open + 1;
      continue;
    }
    const name = `${start[1] ?? ''}${(start[2] ?? '').toLowerCase()}`;
    /** @type {Map<string, string>} */
    const attributes = new Map();
    let j = open + start[0].length;
    let selfClosing = false;
    // Where the last unquoted value ended: a / there is the value's (width=24/).
    let unquotedEnd = -1;
    while (j < html.length) {
      while (j < html.length && /[\s/]/.test(html[j] ?? '')) j += 1;
      if (j >= html.length || html[j] === '>') {
        selfClosing = html[j - 1] === '/' && unquotedEnd !== j;
        j += 1;
        break;
      }
      const attribute = /^[^\s/>=]+/.exec(html.slice(j, j + 256))?.[0] ?? html[j] ?? '';
      j += attribute.length;
      while (/\s/.test(html[j] ?? '')) j += 1;
      let value = '';
      if (html[j] === '=') {
        j += 1;
        while (/\s/.test(html[j] ?? '')) j += 1;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1);
          value = html.slice(j + 1, end === -1 ? html.length : end);
          j = end === -1 ? html.length : end + 1;
        } else {
          value = /^[^\s>]*/.exec(html.slice(j))?.[0] ?? '';
          j += value.length;
          unquotedEnd = j;
        }
      }
      const key = attribute.toLowerCase();
      if (!attributes.has(key)) attributes.set(key, decoded(value));
    }
    tags.push({ name, attributes });
    if (name.startsWith('/')) {
      // Closes the innermost open svg, math or integration point of that
      // name, and what it holds; any other end tag changes nothing here.
      const at = scopes.map((scope) => scope.name).lastIndexOf(name.slice(1));
      if (at !== -1) scopes.length = at;
    } else if (foreign()) {
      if (
        BREAKOUT.has(name) ||
        (name === 'font' && ['color', 'face', 'size'].some((key) => attributes.has(key)))
      ) {
        // Back to HTML: the foreign elements it was in end.
        while (foreign()) scopes.pop();
      } else if (!selfClosing && integrationPoint(scopes.at(-1)?.kind, name, attributes)) {
        scopes.push({ name, kind: 'html' });
      } else if (!selfClosing && (name === 'svg' || name === 'math')) {
        scopes.push({ name, kind: name });
      }
    } else if (name === 'svg' || name === 'math') {
      if (!selfClosing) scopes.push({ name, kind: name });
    } else {
      // A raw text element's text runs to its end tag, whatever it holds.
      if (RAW_TEXT.has(name)) j = endTag(html, name, j);
      if (name === 'plaintext') j = html.length;
    }
    i = j;
  }
  return tags;
}

/**
 * What a page carries that the web server's Content-Security-Policy
 * (apps/web/nginx/security-headers.conf: default-src 'self', no
 * 'unsafe-inline', object-src 'none', base-uri and form-action 'self',
 * images from data: URLs aside) refuses: an inline script or event handler, a
 * `<style>` element or a style attribute, a javascript: URL, an object or an
 * embed, a base or a form pointing elsewhere, a file from another origin, and
 * any of those in an iframe's srcdoc (which takes the page's policy). The
 * preview server sends no CSP, so such a page would break in production only.
 * A JSON-LD block is data, not a script.
 * @param {string} html
 * @returns {string[]}
 */
export function cspProblems(html) {
  /** @type {string[]} */
  const problems = [];
  /** The element a <source> belongs to: its files are images in a picture. */
  let media = '';
  const absolute = isAbsolute;
  for (const { name, attributes } of tagsOf(html)) {
    if (name === 'picture' || name === 'video' || name === 'audio') media = name;
    if (name === '/picture' || name === '/video' || name === '/audio') media = '';
    if (name.startsWith('/')) continue;
    const attribute = (/** @type {string} */ key) => attributes.get(key)?.trim();
    if (
      name === 'script' &&
      attribute('src') === undefined &&
      !/^application\/ld\+json$/i.test(attribute('type') ?? '')
    ) {
      problems.push('an inline script');
    }
    if (name === 'style') problems.push('a <style> element');
    if (attributes.has('style')) problems.push(`a style attribute on <${name}>`);
    if ([...attributes.keys()].some((key) => /^on/.test(key))) {
      problems.push(`an inline event handler on <${name}>`);
    }
    for (const key of ['href', 'xlink:href', 'src', 'action', 'formaction', 'poster', 'data']) {
      if (isJavaScriptUrl(attribute(key) ?? '')) problems.push('a javascript: URL');
    }
    const srcdoc = attributes.get('srcdoc');
    if (name === 'iframe' && srcdoc !== undefined) {
      for (const problem of cspProblems(srcdoc)) problems.push(`in an iframe's srcdoc: ${problem}`);
    }
    if (name === 'object' || name === 'embed' || name === 'applet') {
      problems.push(`an <${name}> (object-src 'none')`);
    }
    const base = attribute('href');
    if (name === 'base' && base !== undefined && absolute(base)) {
      problems.push(`a <base> pointing elsewhere: ${base}`);
    }
    for (const key of ['action', 'formaction']) {
      const target = attribute(key);
      if (target !== undefined && absolute(target) && !isJavaScriptUrl(target)) {
        problems.push(`a form sent to another origin: ${target}`);
      }
    }
    /** @type {{ url: string | undefined; image: boolean }[]} */
    const loaded = [];
    const rels = (attribute('rel') ?? '').split(/\s+/);
    if (name === 'link' && rels.some((rel) => LOADED_LINKS.test(rel))) {
      const image =
        rels.some((rel) => IMAGE_LINKS.test(rel)) || attribute('as')?.toLowerCase() === 'image';
      loaded.push({ url: attribute('href'), image });
      for (const candidate of (attribute('imagesrcset') ?? '').split(',')) {
        loaded.push({ url: candidate.trim().split(/\s+/)[0], image });
      }
    } else if (name === 'use' || name === 'image' || name === 'feimage') {
      const image = name !== 'use';
      loaded.push({ url: attribute('href'), image }, { url: attribute('xlink:href'), image });
    } else if (name !== 'a' && name !== 'area' && name !== 'base' && name !== 'form') {
      const image =
        name === 'img' ||
        (name === 'input' && attribute('type')?.toLowerCase() === 'image') ||
        (name === 'source' && media === 'picture');
      loaded.push({ url: attribute('src'), image });
      for (const candidate of (attribute('srcset') ?? '').split(',')) {
        loaded.push({ url: candidate.trim().split(/\s+/)[0], image });
      }
      if (name === 'video') loaded.push({ url: attribute('poster'), image: true });
    }
    for (const { url, image } of loaded) {
      if (url === undefined || url === '' || isJavaScriptUrl(url)) continue;
      if (image && /^data:/i.test(urlOf(url))) continue;
      if (absolute(url)) problems.push(`a file from another origin: ${url}`);
    }
  }
  return problems;
}

/**
 * What a stylesheet loads that the Content-Security-Policy refuses: an import
 * (`@import`) or a url() from another origin (a web font's stylesheet, for
 * instance: self-host it), or a data: URL that is not an image (only images
 * may come from data: URLs; a font may not).
 * @param {string} css
 * @returns {string[]}
 */
export function cssProblems(css) {
  /** @type {string[]} */
  const problems = [];
  const code = cssWithoutComments(css);
  const imports = cssImports(code);
  for (const [from, to] of imports) {
    const url = /^@import\s*(?:url\(\s*)?["']?([^"')\s;]+)/i.exec(code.slice(from, to))?.[1] ?? '';
    if (isAbsolute(url)) problems.push(`an @import from another origin: ${url}`);
  }
  // The url() of an @import is that import's, reported once.
  let rules = code;
  for (const [from, to] of [...imports].reverse()) rules = rules.slice(0, from) + rules.slice(to);
  for (const [, , url = ''] of rules.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi)) {
    const target = url.trim();
    if (/^data:/i.test(target)) {
      if (!/^data:image\//i.test(target)) problems.push('a data: URL that is not an image');
    } else if (isAbsolute(target)) problems.push(`a file from another origin: ${target}`);
  }
  return problems;
}

/**
 * Where the strings of a stylesheet end, read from `from` on: the index after
 * the string that starts there (a backslash escapes the next character).
 * @param {string} css
 * @param {number} from the opening quote's index
 */
function cssStringEnd(css, from) {
  const quote = css[from];
  let k = from + 1;
  while (k < css.length && css[k] !== quote) k += css[k] === '\\' ? 2 : 1;
  return k + 1;
}

/**
 * A stylesheet without its comments, strings kept as written (a "/*" in a
 * string starts no comment).
 * @param {string} css
 */
function cssWithoutComments(css) {
  let out = '';
  let k = 0;
  while (k < css.length) {
    const c = css[k] ?? '';
    if (c === '"' || c === "'") {
      const end = cssStringEnd(css, k);
      out += css.slice(k, end);
      k = end;
    } else if (css.startsWith('/*', k)) {
      const end = css.indexOf('*/', k + 2);
      k = end === -1 ? css.length : end + 2;
    } else {
      out += c;
      k += 1;
    }
  }
  return out;
}

/**
 * The import rules of a stylesheet (`@import`), outside strings, as
 * [start, end) ranges (to the ; that ends each): a longer at-keyword, or a
 * string that only says the word, is none.
 * @param {string} css a stylesheet without comments
 * @returns {[number, number][]}
 */
function cssImports(css) {
  /** @type {[number, number][]} */
  const ranges = [];
  let k = 0;
  while (k < css.length) {
    const c = css[k] ?? '';
    if (c === '"' || c === "'") {
      k = cssStringEnd(css, k);
      continue;
    }
    if (c === '@' && /^@import(?![\w-])/i.test(css.slice(k, k + 8))) {
      let end = k + 7;
      while (end < css.length && css[end] !== ';') {
        end = css[end] === '"' || css[end] === "'" ? cssStringEnd(css, end) : end + 1;
      }
      ranges.push([k, Math.min(end + 1, css.length)]);
      k = end + 1;
      continue;
    }
    k += 1;
  }
  return ranges;
}

/**
 * A budget measures the assets whose file name matches `pattern`, or, with
 * `initial`, the JavaScript every visit downloads before the app starts. A
 * budget of 0 kB means the build has no such asset at all: matching nothing
 * is its pass, and any file is over it.
 * @typedef {{ name: string; pattern?: string; initial?: boolean; maxGzipKb: number }} Budget
 * @typedef {Omit<Budget, 'pattern'> & { pattern?: RegExp }} CompiledBudget
 */

/**
 * The JavaScript files of the assets folder that index.html loads at once:
 * its module script and every chunk it preloads. The bundler decides how to
 * split the code shared by the entry and the lazy chunks: a shared chunk it
 * preloads is downloaded on every visit, whatever its name, and counts here.
 * @param {string} html
 * @param {string} assetsPath the URL path of the assets folder, such as /assets/
 * @returns {string[]}
 */
export function initialAssets(html, assetsPath = '/assets/') {
  const files = new Set();
  // Tag and attribute names in any letter case, as HTML reads them.
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const isEntry = /^<script\b/i.test(tag) && /\btype=["']?module\b/i.test(tag);
    const isPreload = /^<link\b/i.test(tag) && /\brel=["']?modulepreload\b/i.test(tag);
    const url = /\b(?:src|href)=["']?([^"'\s>]+)/i.exec(tag)?.[1];
    // A file directly in the assets folder, its query or fragment left out.
    const file = url?.startsWith(assetsPath)
      ? /^([^/?#]+\.js)(?:[?#]|$)/i.exec(url.slice(assetsPath.length))?.[1]
      : undefined;
    if ((isEntry || isPreload) && file !== undefined) files.add(file);
  }
  return [...files];
}

/**
 * Checks every budget; returns the report lines and whether any failed.
 * @param {CompiledBudget[]} budgets
 * @param {{ files: string[]; html: string; gzipBytes: (file: string) => number; assetsPath?: string }} build
 */
export function checkBudgets(budgets, { files, html, gzipBytes, assetsPath = '/assets/' }) {
  /** @type {{ ok: boolean; line: string }[]} */
  const lines = [];
  let over = false;
  for (const budget of budgets) {
    const matched = budget.initial
      ? initialAssets(html, assetsPath).filter((file) => files.includes(file))
      : files.filter((file) => budget.pattern?.test(file) === true);
    const kb = matched.reduce((sum, file) => sum + gzipBytes(file), 0) / 1000;
    const line = `${budget.name}: ${kb.toFixed(1)} kB gzip, budget ${budget.maxGzipKb} kB (${matched.length} files)`;
    if (matched.length === 0 && budget.maxGzipKb === 0) {
      lines.push({ ok: true, line: `ok  ${line}` });
    } else if (matched.length > 0 && budget.maxGzipKb === 0) {
      // Even a file that compresses to nothing breaks a "none at all" budget.
      lines.push({ ok: false, line: `OVER BUDGET  ${line}` });
      over = true;
    } else if (matched.length === 0) {
      // A budget that matches nothing measures nothing: a renamed chunk would
      // otherwise pass at 0 kB forever.
      const fix = budget.initial
        ? `index.html loads no script from ${assetsPath.replace(/^\//, '')}`
        : `fix the pattern "${budget.pattern?.source ?? ''}"`;
      lines.push({ ok: false, line: `NO MATCH  ${line}: ${fix}` });
    } else if (kb > budget.maxGzipKb) {
      lines.push({ ok: false, line: `OVER BUDGET  ${line}` });
      over = true;
    } else {
      lines.push({ ok: true, line: `ok  ${line}` });
    }
  }
  return { lines, over, failed: lines.some((entry) => !entry.ok) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let failed = false;
  let over = false;
  let refused = false;
  for (const app of APPS) {
    const assets = new URL(app.assets, app.dist);
    console.log(`${app.name}:`);
    if (!existsSync(assets)) {
      console.error(
        `No ${app.name} build found in apps/${app.name}/dist: run \`pnpm build\` first.`,
      );
      failed = true;
      continue;
    }
    const { budgets } = /** @type {{ budgets: Budget[] }} */ (
      JSON.parse(readFileSync(app.budget, 'utf8'))
    );
    // The patterns come from the repository's own budget files.
    /** @type {CompiledBudget[]} */
    const compiled = [];
    for (const { pattern, ...budget } of budgets) {
      compiled.push(pattern === undefined ? budget : { ...budget, pattern: new RegExp(pattern) });
    }
    const result = checkBudgets(compiled, {
      files: readdirSync(assets),
      html: readFileSync(new URL('index.html', app.dist), 'utf8'),
      gzipBytes: (file) => gzipSync(readFileSync(new URL(file, assets))).length,
      assetsPath: app.assetsPath,
    });
    for (const { ok, line } of result.lines) (ok ? console.log : console.error)(`  ${line}`);
    failed ||= result.failed;
    over ||= result.over;
    const stylesheets = readdirSync(assets).filter((file) => file.endsWith('.css'));
    let refusedStyles = 0;
    for (const file of stylesheets) {
      for (const problem of cssProblems(readFileSync(new URL(file, assets), 'utf8'))) {
        console.error(`  REFUSED BY THE CSP  ${app.assets}${file}: ${problem}`);
        refusedStyles += 1;
      }
    }
    if (refusedStyles === 0) {
      console.log(
        `  ok  stylesheets: nothing the Content-Security-Policy refuses (${String(stylesheets.length)} files)`,
      );
    }
    refused ||= refusedStyles > 0;
    if (app.pages === true) {
      const pages = readdirSync(app.dist, { recursive: true })
        .map((file) => String(file).replaceAll('\\', '/'))
        .filter((file) => file.endsWith('.html'));
      let found = 0;
      for (const page of pages) {
        for (const problem of cspProblems(readFileSync(new URL(page, app.dist), 'utf8'))) {
          console.error(`  REFUSED BY THE CSP  ${page}: ${problem}`);
          found += 1;
        }
      }
      if (found === 0) {
        console.log(
          `  ok  pages: nothing the Content-Security-Policy refuses (${String(pages.length)} pages)`,
        );
      }
      refused ||= found > 0;
    }
  }
  if (refused) {
    console.error(
      'A page or a stylesheet carries what the Content-Security-Policy refuses in production: scripts, styles and fonts go in files of this origin, never inline or from another site (docs/how-to.md#change-the-landing).',
    );
  }
  if (over) {
    console.error(
      'Shrink the bundle (lazy-load routes, drop heavy dependencies), or raise the budget in a reviewed pull request that explains why.',
    );
  }
  if (failed || refused) process.exit(1);
}

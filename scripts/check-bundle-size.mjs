// Performance budget (docs/testing.md#performance-budget): fails when the
// built assets of an app outgrow its performance-budget.json (the web app's
// and the landing's), or when a page of the landing, or a stylesheet of
// either, carries what the web server's Content-Security-Policy refuses. Sizes are gzip, what browsers
// actually download, in kB of 1000 bytes like Vite reports. Run after
// `pnpm build`; part of `pnpm verify` and CI.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { parse } from 'parse5';

/** @typedef {import('parse5').DefaultTreeAdapterMap['parentNode']} ParentNode */

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
 * The elements of an HTML document, in document order, as a browser builds
 * them: parse5 follows the HTML standard (raw text elements, comments,
 * character references, SVG and MathML with their integration points and the
 * tags that leave them). With scripting off, a <noscript>'s content is
 * elements too (a browser without JavaScript renders it), and a <template>'s
 * content is read (a script may put it in the page). Names and attribute
 * names come in lower case, a namespaced attribute with its prefix
 * (xlink:href); `parent` is the enclosing element's name.
 * @param {string} html
 * @returns {{ name: string; parent: string; attributes: Map<string, string> }[]}
 */
export function elementsOf(html) {
  /** @type {{ name: string; parent: string; attributes: Map<string, string> }[]} */
  const elements = [];
  /**
   * @param {ParentNode} node
   * @param {string} parent
   */
  const visit = (node, parent) => {
    for (const child of node.childNodes) {
      if (!('tagName' in child)) continue;
      const name = child.tagName.toLowerCase();
      /** @type {Map<string, string>} */
      const attributes = new Map();
      for (const attribute of child.attrs) {
        const key = (
          attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name
        ).toLowerCase();
        if (!attributes.has(key)) attributes.set(key, attribute.value);
      }
      elements.push({ name, parent, attributes });
      visit('content' in child ? child.content : child, name);
    }
  };
  visit(parse(html, { scriptingEnabled: false }), '');
  return elements;
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
  const absolute = isAbsolute;
  for (const { name, parent, attributes } of elementsOf(html)) {
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
        // A <source> of a picture: its files are images.
        (name === 'source' && parent === 'picture');
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
 * the string that starts there (a backslash escapes the next character, a
 * line break included). A line break the string does not escape ends it
 * there, as a browser ends it (a bad string): what follows is read as rules.
 * @param {string} css
 * @param {number} from the opening quote's index
 */
function cssStringEnd(css, from) {
  const quote = css[from];
  let k = from + 1;
  while (k < css.length && css[k] !== quote) {
    if (/[\n\r\f]/.test(css[k] ?? '')) return k;
    k += css[k] === '\\' ? 2 : 1;
  }
  return k + 1;
}

/**
 * A stylesheet without its comments, strings kept as written (a "/*" in a
 * string starts no comment). Outside a string, a backslash escapes the next
 * character: an escaped quote starts no string.
 * @param {string} css
 */
function cssWithoutComments(css) {
  let out = '';
  let k = 0;
  while (k < css.length) {
    const c = css[k] ?? '';
    if (c === '\\') {
      out += css.slice(k, k + 2);
      k += 2;
    } else if (c === '"' || c === "'") {
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
    if (c === '\\') {
      k += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      k = cssStringEnd(css, k);
      continue;
    }
    if (c === '@' && /^@import(?![\w-])/i.test(css.slice(k, k + 8))) {
      let end = k + 7;
      while (end < css.length && css[end] !== ';') {
        if (css[end] === '\\') end += 2;
        else if (css[end] === '"' || css[end] === "'") end = cssStringEnd(css, end);
        else end += 1;
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

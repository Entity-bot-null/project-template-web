// Performance budget (docs/testing.md#performance-budget): fails when the
// files of an app's build (the bundler's and those copied from public/) outgrow
// its performance-budget.json (the web app's and the landing's), or when a
// page of the landing, or a stylesheet of either, carries what the web
// server's Content-Security-Policy refuses. Sizes are gzip, what browsers
// actually download, in kB of 1000 bytes like Vite reports. Run after
// `pnpm build`; part of `pnpm verify` and CI.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { parse } from 'parse5';

/** @typedef {import('parse5').DefaultTreeAdapterMap['parentNode']} ParentNode */

/**
 * Each app with a budget: its build folder (every file in it is measured and
 * read: builtFiles), the folder of hashed assets inside it, where index.html
 * loads its initial scripts from, that folder's URL path on the site (the web
 * app is served under /app/) and its budget file.
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
 * tags that leave them). `scripting`: as a browser with JavaScript parses it
 * (a <noscript>'s content is text), or, off, as one without (that content is
 * elements, which it renders). A <template>'s content is read (a script may
 * put it in the page). Names and attribute names come in lower case, a
 * namespaced attribute with its prefix (xlink:href); `parent` is the
 * enclosing element's name.
 * @param {string} html
 * @param {{ scripting?: boolean }} [options]
 * @returns {{ name: string; parent: string; attributes: Map<string, string> }[]}
 */
export function elementsOf(html, { scripting = false } = {}) {
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
  visit(parse(html, { scriptingEnabled: scripting }), '');
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
 * A JSON-LD block is data, not a script. The page is read as browsers with
 * and without JavaScript parse it (a <noscript> reads differently in each:
 * elementsOf), each problem once.
 * @param {string} html
 * @returns {string[]}
 */
export function cspProblems(html) {
  const without = problemsOf(elementsOf(html));
  const more = problemsOf(elementsOf(html, { scripting: true }));
  for (const problem of without) {
    const same = more.indexOf(problem);
    if (same !== -1) more.splice(same, 1);
  }
  return [...without, ...more];
}

/**
 * What the elements of a page carry that the policy refuses (cspProblems).
 * @param {ReturnType<typeof elementsOf>} elements
 * @returns {string[]}
 */
function problemsOf(elements) {
  /** @type {string[]} */
  const problems = [];
  const absolute = isAbsolute;
  for (const { name, parent, attributes } of elements) {
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
 * (`@import`) or a file (url(), and the strings of src(), image-set() and
 * image()) from another origin (a web font's stylesheet, for instance:
 * self-host it), or a data: URL that is not an image (only images may come
 * from data: URLs; a font may not).
 * @param {string} css
 * @returns {string[]}
 */
export function cssProblems(css) {
  /** @type {string[]} */
  const problems = [];
  for (const { url, imported } of cssUrls(css)) {
    const target = url.trim();
    if (imported) {
      if (isAbsolute(target)) problems.push(`an @import from another origin: ${target}`);
    } else if (/^data:/i.test(target)) {
      if (!/^data:image\//i.test(target)) problems.push('a data: URL that is not an image');
    } else if (isAbsolute(target)) problems.push(`a file from another origin: ${target}`);
  }
  return problems;
}

// The functions whose strings are URLs a browser fetches (CSS Values, CSS
// Images): url("...") and src("..."), and the candidates of image-set() and
// image().
const URL_FUNCTIONS = new Set(['url', 'src', 'image-set', '-webkit-image-set', 'image']);

/**
 * The URLs a stylesheet loads, in order, read as a browser tokenizes it (CSS
 * Syntax Level 3): CRLF, CR and FF are line breaks; comments; strings, where
 * a backslash escapes the next character (an escaped line break goes on with
 * the string) and a line break it does not escape ends a bad string, which a
 * browser drops; escapes outside strings (an escaped quote starts no string);
 * unquoted url() values (a bad one is dropped too); hashes (#name), which
 * call no function; the strings of URL_FUNCTIONS. `imported`: the URL of an
 * `@import`. A URL elsewhere in an at-rule's prelude (an `@namespace`'s, an
 * `@supports` condition's) is fetched by nothing.
 * @param {string} css
 * @returns {{ url: string; imported: boolean }[]}
 */
function cssUrls(css) {
  const text = css.replace(/\r\n?|\f/g, '\n');
  /** @type {{ url: string; imported: boolean }[]} */
  const urls = [];
  // The functions and parentheses open around k, innermost last ('' for a
  // plain parenthesis).
  /** @type {string[]} */
  const open = [];
  // The at-rule whose prelude k is in, before its URL ('' outside one).
  let rule = '';
  let k = 0;
  const at = (/** @type {number} */ i) => text[i] ?? '';
  const space = (/** @type {number} */ i) => /^[ \t\n]$/.test(at(i));
  // A backslash that starts an escape: not one before a line break or at the end.
  const escapes = (/** @type {number} */ i) =>
    at(i) === '\\' && i + 1 < text.length && at(i + 1) !== '\n';
  const identChar = (/** @type {string} */ c) => /^[\w-]$/.test(c) || c.charCodeAt(0) >= 0x80;
  // What an unquoted url() may not hold (a bad url): controls other than
  // tab, line feed and carriage return, and delete.
  const nonPrintable = (/** @type {string} */ c) => {
    const code = c.charCodeAt(0);
    return code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
  };

  // The character an escape stands for, read from k (past its backslash):
  // up to six hex digits and one white space after them, or the character.
  const escape = () => {
    const hex = /^[0-9a-f]{1,6}/i.exec(text.slice(k, k + 6))?.[0];
    if (hex === undefined) {
      const c = String.fromCodePoint(text.codePointAt(k) ?? 0xfffd);
      k += c.length;
      return c;
    }
    k += hex.length;
    if (space(k)) k += 1;
    const code = Number.parseInt(hex, 16);
    return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff
      ? '\ufffd'
      : String.fromCodePoint(code);
  };
  const ident = () => {
    let name = '';
    while (k < text.length) {
      if (identChar(at(k))) {
        name += at(k);
        k += 1;
      } else if (escapes(k)) {
        k += 1;
        name += escape();
      } else break;
    }
    return name;
  };
  /** @returns {string | undefined} undefined for a bad string */
  const string = () => {
    const quote = at(k);
    k += 1;
    let value = '';
    while (k < text.length) {
      const c = at(k);
      if (c === quote) {
        k += 1;
        return value;
      }
      if (c === '\n') return undefined;
      if (c === '\\') {
        k += 1;
        if (at(k) === '\n') k += 1;
        else if (k < text.length) value += escape();
      } else {
        value += c;
        k += 1;
      }
    }
    return value;
  };
  // The rest of a bad url(), to its closing parenthesis.
  const badUrl = () => {
    while (k < text.length && at(k) !== ')') k += escapes(k) ? 2 : 1;
    k += 1;
    return undefined;
  };
  /** @returns {string | undefined} undefined for a bad url */
  const unquotedUrl = () => {
    while (space(k)) k += 1;
    let value = '';
    while (k < text.length) {
      const c = at(k);
      if (c === ')') {
        k += 1;
        return value;
      }
      if (space(k)) {
        while (space(k)) k += 1;
        if (k >= text.length) return value;
        if (at(k) !== ')') return badUrl();
        k += 1;
        return value;
      }
      if (c === '"' || c === "'" || c === '(' || nonPrintable(c)) return badUrl();
      if (c === '\\') {
        if (!escapes(k)) return badUrl();
        k += 1;
        value += escape();
      } else {
        value += c;
        k += 1;
      }
    }
    return value;
  };
  // Outside an at-rule's prelude, a file; in an @import's, the first URL is
  // the one it loads. Any other in a prelude (an @namespace's, one in an
  // @supports or a supports() condition, an @import's once its URL is read)
  // is fetched by nothing.
  const found = (/** @type {string} */ url) => {
    if (rule === '') urls.push({ url, imported: false });
    else if (rule === 'import') {
      urls.push({ url, imported: true });
      rule = 'import, read';
    }
  };

  while (k < text.length) {
    const c = at(k);
    if (text.startsWith('/*', k)) {
      const end = text.indexOf('*/', k + 2);
      k = end === -1 ? text.length : end + 2;
    } else if (c === '"' || c === "'") {
      const value = string();
      const inner = open.at(-1);
      const isUrl = inner === undefined ? rule === 'import' : URL_FUNCTIONS.has(inner);
      if (value !== undefined && isUrl) found(value);
    } else if (identChar(c) || escapes(k)) {
      const name = ident().toLowerCase();
      if (at(k) !== '(') continue;
      k += 1;
      let next = k;
      while (space(next)) next += 1;
      if (name === 'url' && at(next) !== '"' && at(next) !== "'") {
        const value = unquotedUrl();
        if (value !== undefined) found(value);
      } else open.push(name);
    } else if (c === '@') {
      k += 1;
      rule = ident().toLowerCase();
    } else if (c === '#' && (identChar(at(k + 1)) || escapes(k + 1))) {
      // A hash (#url is a name, as in a color or an id selector): no function.
      k += 1;
      ident();
    } else {
      if (c === '(') open.push('');
      else if (c === ')') open.pop();
      else if ((c === ';' || c === '{' || c === '}') && open.length === 0) rule = '';
      k += 1;
    }
  }
  return urls;
}

/**
 * Every file of a build, as paths relative to its folder with forward
 * slashes, in order: the bundler's assets and what it copied from public/
 * alike (a script or a stylesheet put there reaches the pages as much as a
 * bundled one does).
 * @param {URL} dist the build folder
 * @returns {string[]}
 */
export function builtFiles(dist) {
  const root = fileURLToPath(dist);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
}

/** The name of a build's file, without its folders. */
const fileName = (/** @type {string} */ file) => file.slice(file.lastIndexOf('/') + 1);

/**
 * A budget measures the build's files whose name matches `pattern`, wherever
 * they are in the build, or, with `initial`, the JavaScript every visit
 * downloads before the app starts. A budget of 0 kB means the build has no
 * such file at all: matching nothing is its pass, and any file is over it.
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
      ? /^([^/?#]+\.m?js)(?:[?#]|$)/i.exec(url.slice(assetsPath.length))?.[1]
      : undefined;
    if ((isEntry || isPreload) && file !== undefined) files.add(file);
  }
  return [...files];
}

/**
 * Checks every budget; returns the report lines and whether any failed.
 * `files` are the build's (builtFiles); `assets` is the folder of hashed
 * assets among them (`assets/`), whose URL path is `assetsPath`: the initial
 * JavaScript is found there.
 * @param {CompiledBudget[]} budgets
 * @param {{ files: string[]; html: string; gzipBytes: (file: string) => number; assets?: string; assetsPath?: string }} build
 */
export function checkBudgets(
  budgets,
  { files, html, gzipBytes, assets = '', assetsPath = '/assets/' },
) {
  /** @type {{ ok: boolean; line: string }[]} */
  const lines = [];
  let over = false;
  for (const budget of budgets) {
    const matched = budget.initial
      ? initialAssets(html, assetsPath)
          .map((file) => `${assets}${file}`)
          .filter((file) => files.includes(file))
      : files.filter((file) => budget.pattern?.test(fileName(file)) === true);
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
    // The patterns come from the repository's own budget files. They match
    // file names whatever the letter case of their extension (widget.JS is a
    // script as much as widget.js), like the stylesheet and page checks.
    /** @type {CompiledBudget[]} */
    const compiled = [];
    for (const { pattern, ...budget } of budgets) {
      compiled.push(
        pattern === undefined ? budget : { ...budget, pattern: new RegExp(pattern, 'i') },
      );
    }
    // Every file of the build: what public/ holds goes out with the pages too.
    const root = fileURLToPath(app.dist);
    const read = (/** @type {string} */ file) => readFileSync(join(root, file));
    const files = builtFiles(app.dist);
    const result = checkBudgets(compiled, {
      files,
      html: read('index.html').toString('utf8'),
      gzipBytes: (file) => gzipSync(read(file)).length,
      assets: app.assets,
      assetsPath: app.assetsPath,
    });
    for (const { ok, line } of result.lines) (ok ? console.log : console.error)(`  ${line}`);
    failed ||= result.failed;
    over ||= result.over;
    const stylesheets = files.filter((file) => /\.css$/i.test(file));
    let refusedStyles = 0;
    for (const file of stylesheets) {
      for (const problem of cssProblems(read(file).toString('utf8'))) {
        console.error(`  REFUSED BY THE CSP  ${file}: ${problem}`);
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
      const pages = files.filter((file) => /\.html?$/i.test(file));
      let found = 0;
      for (const page of pages) {
        for (const problem of cspProblems(read(page).toString('utf8'))) {
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

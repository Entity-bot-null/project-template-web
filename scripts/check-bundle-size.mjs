// Performance budget (docs/testing.md#performance-budget): fails when the
// built assets of an app outgrow its performance-budget.json (the web app's
// and the landing's), or when a page of the landing carries what the web
// server's Content-Security-Policy refuses. Sizes are gzip, what browsers
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

/**
 * The few character references a URL in our pages may use.
 * @param {string} value
 */
function decoded(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (/** @type {string} */ _, /** @type {string} */ hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);?/g, (/** @type {string} */ _, /** @type {string} */ dec) =>
      String.fromCodePoint(Number(dec)),
    )
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * The tags of an HTML document, read as a browser reads them: a quoted
 * attribute value may hold `>`, comments are skipped, and the text of a
 * script or style element is not markup. End tags come as `/name`.
 * @param {string} html
 * @returns {{ name: string; attributes: Map<string, string> }[]}
 */
export function tagsOf(html) {
  const lower = html.toLowerCase();
  /** @type {{ name: string; attributes: Map<string, string> }[]} */
  const tags = [];
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf('<', i);
    if (open === -1) break;
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
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
    while (j < html.length) {
      while (j < html.length && /[\s/]/.test(html[j] ?? '')) j += 1;
      if (j >= html.length || html[j] === '>') {
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
        }
      }
      const key = attribute.toLowerCase();
      if (!attributes.has(key)) attributes.set(key, decoded(value));
    }
    tags.push({ name, attributes });
    // A script's or a style's text runs to its end tag, whatever it holds.
    if (name === 'script' || name === 'style') {
      const end = lower.indexOf(`</${name}`, j);
      j = end === -1 ? html.length : end;
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
 * embed, a base or a form pointing elsewhere, a file from another origin. The
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
  const absolute = (/** @type {string} */ url) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
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
      if (/^javascript:/i.test(attribute(key) ?? '')) problems.push('a javascript: URL');
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
      if (target !== undefined && absolute(target) && !/^javascript:/i.test(target)) {
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
      if (url === undefined || url === '' || /^javascript:/i.test(url)) continue;
      if (image && /^data:/i.test(url)) continue;
      if (absolute(url)) problems.push(`a file from another origin: ${url}`);
    }
  }
  return problems;
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
      'A page carries what the Content-Security-Policy refuses in production: scripts and styles go in files of this origin, never inline (docs/how-to.md#change-the-landing).',
    );
  }
  if (over) {
    console.error(
      'Shrink the bundle (lazy-load routes, drop heavy dependencies), or raise the budget in a reviewed pull request that explains why.',
    );
  }
  if (failed || refused) process.exit(1);
}

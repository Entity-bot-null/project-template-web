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

/** `<link rel>` values that make the browser load the URL. */
const LOADED_LINKS =
  /^(?:stylesheet|icon|apple-touch-icon|mask-icon|manifest|preload|modulepreload|prefetch)$/i;

/** The attributes the check reads: a value quoted either way, or not at all. */
const ATTRIBUTES = {
  href: /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
  rel: /\srel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
  src: /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
  srcset: /\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
  style: /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
  type: /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
};

/**
 * An attribute's value in a start tag; undefined when absent.
 * @param {string} tag
 * @param {keyof typeof ATTRIBUTES} name
 */
function attributeOf(tag, name) {
  const match = ATTRIBUTES[name].exec(tag);
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3] ?? '');
}

/**
 * What a page carries that the web server's Content-Security-Policy
 * (apps/web/nginx/security-headers.conf: default-src 'self', no
 * 'unsafe-inline', images from data: URLs aside) refuses: an inline script or
 * event handler, a `<style>` element or a style attribute, a javascript: URL,
 * a file from another origin. The preview server sends no CSP, so such a page
 * would break in production only. A JSON-LD block is data, not a script.
 * @param {string} html
 * @returns {string[]}
 */
export function cspProblems(html) {
  /** @type {string[]} */
  const problems = [];
  for (const [tag] of html.matchAll(/<[a-z][\w-]*\b[^>]*>/gi)) {
    const name = /^<([\w-]+)/.exec(tag)?.[1]?.toLowerCase() ?? '';
    const type = attributeOf(tag, 'type') ?? '';
    if (
      name === 'script' &&
      attributeOf(tag, 'src') === undefined &&
      !/^application\/ld\+json$/i.test(type)
    ) {
      problems.push('an inline script');
    }
    if (name === 'style') problems.push('a <style> element');
    if (attributeOf(tag, 'style') !== undefined) problems.push(`a style attribute on <${name}>`);
    if (/\son[a-z]+\s*=/i.test(tag)) problems.push(`an inline event handler on <${name}>`);
    if (/^\s*javascript:/i.test(attributeOf(tag, 'href') ?? '')) problems.push('a javascript: URL');
    const rels = (attributeOf(tag, 'rel') ?? '').split(/\s+/);
    const loaded =
      name === 'link'
        ? rels.some((rel) => LOADED_LINKS.test(rel))
          ? [attributeOf(tag, 'href')]
          : []
        : [
            attributeOf(tag, 'src'),
            ...(attributeOf(tag, 'srcset') ?? '')
              .split(',')
              .map((candidate) => candidate.trim().split(/\s+/)[0]),
          ];
    const image = name === 'img' || name === 'source';
    for (const url of loaded) {
      if (url === undefined || url === '') continue;
      if (image && /^data:/i.test(url)) continue;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url))
        problems.push(`a file from another origin: ${url}`);
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

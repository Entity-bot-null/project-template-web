// Performance budget (docs/testing.md#performance-budget): fails when the
// built web assets outgrow apps/web/performance-budget.json. Sizes are gzip,
// what browsers actually download, in kB of 1000 bytes like Vite reports.
// Run after `pnpm build`; part of `pnpm verify` and CI.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const DIST = new URL('../apps/web/dist/', import.meta.url);
const ASSETS = new URL('assets/', DIST);
const BUDGET_FILE = new URL('../apps/web/performance-budget.json', import.meta.url);

/**
 * A budget measures the assets whose file name matches `pattern`, or, with
 * `initial`, the JavaScript every visit downloads before the app starts.
 * @typedef {{ name: string; pattern?: string; initial?: boolean; maxGzipKb: number }} Budget
 * @typedef {Omit<Budget, 'pattern'> & { pattern?: RegExp }} CompiledBudget
 */

/**
 * The JavaScript files of assets/ that index.html loads at once: its module
 * script and every chunk it preloads. The bundler decides how to split the
 * code shared by the entry and the lazy chunks: a shared chunk it preloads is
 * downloaded on every visit, whatever its name, and counts here.
 * @param {string} html
 * @returns {string[]}
 */
export function initialAssets(html) {
  const files = new Set();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
    const isEntry = /^<script\b/.test(tag) && /\btype="module"/.test(tag);
    const isPreload = /^<link\b/.test(tag) && /\brel="modulepreload"/.test(tag);
    const url = /\b(?:src|href)="\/assets\/([^"/]+\.js)"/.exec(tag)?.[1];
    if ((isEntry || isPreload) && url !== undefined) files.add(url);
  }
  return [...files];
}

/**
 * Checks every budget; returns the report lines and whether any failed.
 * @param {CompiledBudget[]} budgets
 * @param {{ files: string[]; html: string; gzipBytes: (file: string) => number }} build
 */
export function checkBudgets(budgets, { files, html, gzipBytes }) {
  /** @type {{ ok: boolean; line: string }[]} */
  const lines = [];
  let over = false;
  for (const budget of budgets) {
    const matched = budget.initial
      ? initialAssets(html).filter((file) => files.includes(file))
      : files.filter((file) => budget.pattern?.test(file) === true);
    const kb = matched.reduce((sum, file) => sum + gzipBytes(file), 0) / 1000;
    const line = `${budget.name}: ${kb.toFixed(1)} kB gzip, budget ${budget.maxGzipKb} kB (${matched.length} files)`;
    if (matched.length === 0) {
      // A budget that matches nothing measures nothing: a renamed chunk would
      // otherwise pass at 0 kB forever.
      const fix = budget.initial
        ? 'index.html loads no script from assets/'
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
  if (!existsSync(ASSETS)) {
    console.error('No web build found in apps/web/dist: run `pnpm build` first.');
    process.exit(1);
  }
  const { budgets } = /** @type {{ budgets: Budget[] }} */ (
    JSON.parse(readFileSync(BUDGET_FILE, 'utf8'))
  );
  // The patterns come from the repository's own budget file.
  /** @type {CompiledBudget[]} */
  const compiled = [];
  for (const { pattern, ...budget } of budgets) {
    compiled.push(pattern === undefined ? budget : { ...budget, pattern: new RegExp(pattern) });
  }
  const { lines, over, failed } = checkBudgets(compiled, {
    files: readdirSync(ASSETS),
    html: readFileSync(new URL('index.html', DIST), 'utf8'),
    gzipBytes: (file) => gzipSync(readFileSync(new URL(file, ASSETS))).length,
  });
  for (const { ok, line } of lines) (ok ? console.log : console.error)(line);
  if (over) {
    console.error(
      'Shrink the bundle (lazy-load routes, drop heavy dependencies), or raise the budget in a reviewed pull request that explains why.',
    );
  }
  if (failed) process.exit(1);
}

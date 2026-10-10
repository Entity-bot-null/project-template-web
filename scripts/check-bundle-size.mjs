// Performance budget (docs/testing.md#performance-budget): fails when the
// built web assets outgrow apps/web/performance-budget.json. Sizes are gzip,
// what browsers actually download, in kB of 1000 bytes like Vite reports.
// Run after `pnpm build`; part of `pnpm verify` and CI.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const ASSETS = new URL('../apps/web/dist/assets/', import.meta.url);
const BUDGET_FILE = new URL('../apps/web/performance-budget.json', import.meta.url);

/** @typedef {{ name: string; pattern: string; maxGzipKb: number }} Budget */

if (!existsSync(ASSETS)) {
  console.error('No web build found in apps/web/dist: run `pnpm build` first.');
  process.exit(1);
}

const { budgets } = /** @type {{ budgets: Budget[] }} */ (
  JSON.parse(readFileSync(BUDGET_FILE, 'utf8'))
);
const files = readdirSync(ASSETS);

let failed = false;
let over = false;
for (const budget of budgets) {
  const pattern = new RegExp(budget.pattern);
  const matched = files.filter((file) => pattern.test(file));
  const bytes = matched.reduce(
    (sum, file) => sum + gzipSync(readFileSync(new URL(file, ASSETS))).length,
    0,
  );
  const kb = bytes / 1000;
  const line = `${budget.name}: ${kb.toFixed(1)} kB gzip, budget ${budget.maxGzipKb} kB (${matched.length} files)`;
  if (matched.length === 0) {
    // A pattern that matches nothing measures nothing: a renamed chunk would
    // otherwise pass at 0 kB forever.
    console.error(`NO MATCH  ${line}: fix the pattern "${budget.pattern}"`);
    failed = true;
  } else if (kb > budget.maxGzipKb) {
    console.error(`OVER BUDGET  ${line}`);
    failed = true;
    over = true;
  } else {
    console.log(`ok  ${line}`);
  }
}

if (over) {
  console.error(
    'Shrink the bundle (lazy-load routes, drop heavy dependencies), or raise the budget in a reviewed pull request that explains why.',
  );
}
if (failed) process.exit(1);

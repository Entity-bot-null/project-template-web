// The Astro CLI as this repository runs it, the same on a developer's
// machine, in CI and in the image build:
//
// - usage telemetry off: the template reports nothing home (the reason
//   pnpm-workspace.yaml never runs @scarf/scarf either), and this environment
//   variable is the switch Astro reads on every command
//   (https://astro.build/telemetry);
// - the dev and preview servers in the foreground: Astro moves them to a
//   background process when it detects a coding agent, where pnpm dev and
//   Playwright could no longer stop them and a forgotten one would keep its
//   port. --ignore-lock is Astro's switch for a foreground server.
//
// Every other argument goes to the CLI unchanged:
//
//   node scripts/astro.mjs build
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const manifest = createRequire(import.meta.url).resolve('astro/package.json');
const { bin } = /** @type {{ bin: { astro: string } }} */ (
  JSON.parse(readFileSync(manifest, 'utf8'))
);
const args = process.argv.slice(2);
const [command, subcommand] = args;
const startsServer =
  (command === 'dev' || command === 'preview') &&
  (subcommand === undefined || subcommand.startsWith('-'));
if (startsServer && !args.includes('--background') && !args.includes('--ignore-lock')) {
  args.push('--ignore-lock');
}
const cli = spawn(process.execPath, [join(dirname(manifest), bin.astro), ...args], {
  stdio: 'inherit',
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
});
cli.on('error', (error) => {
  console.error(`Could not start the Astro CLI (${error.message}).`);
  process.exitCode = 1;
});

// Ctrl+C reaches the CLI directly (same process group); a stop sent to this
// process alone (pnpm --parallel stopping the other servers) is passed on.
process.on('SIGINT', () => {
  // Nothing: the CLI got it too, and its exit ends this script.
});
process.on('SIGTERM', () => cli.kill('SIGTERM'));
cli.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 130 : 1);
});

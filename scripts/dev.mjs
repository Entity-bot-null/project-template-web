// `pnpm dev`, once the database is up: the API and web dev servers (pnpm
// --parallel, their output passed through as it comes), then the box of
// scripts/dev-banner.mjs under their logs, each time the API has started or
// restarted after a change and the web server answers. The addresses stay at
// the bottom of the terminal instead of scrolling away with the start-up logs.
//
//   node scripts/dev.mjs
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { currentBanner, currentSettings } from './dev-banner.mjs';

// NestApplication's last start-up line, logged once app.listen has returned
// (apps/api/src/server.ts): the API answers from then on.
const API_READY = /Nest application successfully started/;

/**
 * A consumer of the servers' output that calls `onReady` for every line that
 * says the API has started. Output comes in chunks that can split a line, and
 * with colors and pnpm's "apps/api dev:" prefix.
 * @param {() => void} onReady
 */
export function apiReadyWatcher(onReady) {
  let pending = '';
  return (/** @type {string} */ chunk) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (API_READY.test(stripVTControlCharacters(line))) onReady();
    }
  };
}

/**
 * How to start pnpm without a shell: the pnpm that runs `pnpm dev`, which it
 * names in npm_execpath. A JavaScript entry point runs with this Node.js (no
 * .cmd shim, so Windows works too); a native binary runs as it is. Without
 * npm_execpath (this script started by hand), `pnpm` from the PATH.
 * @param {string | undefined} execPath npm_execpath, resolved
 * @param {string[]} args
 * @returns {[command: string, args: string[]]}
 */
export function pnpmCommand(execPath, args) {
  if (!execPath) return ['pnpm', args];
  return /\.[cm]?js$/.test(execPath) ? [process.execPath, [execPath, ...args]] : [execPath, args];
}

/**
 * Whether `url` answers within `timeoutMs` (any HTTP status will do).
 * @param {string} url
 */
async function answers(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      await delay(250);
    }
  }
  return false;
}

const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isCli) {
  // Piped, the servers would drop their colors: keep them when this output
  // is a terminal, as it would be without this script.
  const colors = process.stdout.isTTY && !process.env.NO_COLOR ? { FORCE_COLOR: '1' } : {};
  const execPath = process.env.npm_execpath && realpathSync(process.env.npm_execpath);
  const [command, args] = pnpmCommand(execPath, [
    '--parallel',
    '--filter',
    'api',
    '--filter',
    'web',
    'dev',
  ]);
  const servers = spawn(command, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, ...colors },
  });
  servers.on('error', (error) => {
    console.error(`Could not start pnpm (${error.message}): run this through \`pnpm dev\`.`);
    process.exitCode = 1;
  });

  // One box at a time, after the web server answers (at most 30 s: a web
  // server that does not start still gets the box, under its error).
  let shown = Promise.resolve();
  const showBanner = () => {
    shown = shown.then(async () => {
      await answers(currentSettings().web);
      process.stdout.write(`\n${currentBanner()}\n\n`);
    });
  };
  const watch = apiReadyWatcher(showBanner);
  servers.stdout.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
    process.stdout.write(chunk);
    watch(chunk);
  });
  servers.stderr.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
    process.stderr.write(chunk);
  });

  // Ctrl+C reaches the servers directly (same process group): this script
  // waits for them to stop and exits with their status.
  process.on('SIGINT', () => {
    // Nothing: the servers got it too, and their exit ends this script.
  });
  process.on('SIGTERM', () => servers.kill('SIGTERM'));
  servers.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 130 : 1);
  });
}

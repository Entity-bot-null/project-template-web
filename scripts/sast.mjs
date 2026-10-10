// `pnpm sast` and the CI job "Static analysis (Semgrep)": static application
// security testing of the code, Dockerfiles and nginx configuration
// (docs/security.md#static-analysis). Needs Docker. Any finding fails.
//
// The rulesets are Semgrep's curated, high-confidence ones. A false positive
// is suppressed where it occurs, with the reason, so review sees it:
//   // nosemgrep: <rule-id> -- why this is safe
//
// What is scanned: the files git tracks plus the new ones it would pick up
// (not ignored), copied to a temporary directory first, minus .semgrepignore
// (copied with them). The same files Semgrep selects when it is given the
// working tree, without Docker having to share the whole tree: mounting it
// makes Docker Desktop expose node_modules and every build output, which
// takes many minutes on Windows and macOS. Symbolic links are not followed:
// their targets are not part of the repository's content. An nginx template
// (`*.conf.template`) is copied under the name nginx renders it to, since
// Semgrep's nginx rules only select `*.conf` files (copyName).
import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTool } from './tool-image.mjs';

export const RULESETS = [
  'p/default',
  'p/owasp-top-ten',
  'p/typescript',
  'p/nodejs',
  'p/expressjs',
  'p/react',
  'p/jwt',
  'p/secrets',
  'p/dockerfile',
  'p/nginx',
];

/**
 * The files to scan, relative to `root`: tracked, plus untracked ones git
 * does not ignore. Regular files only (links and deleted files left out).
 * @param {string} [root]
 * @returns {{ files: string[]; links: string[] }}
 */
export function selectFiles(root = process.cwd()) {
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split('\0')
    .filter((file) => file.length > 0);
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const links = [];
  for (const file of [...new Set(listed)].sort()) {
    let stat;
    try {
      stat = lstatSync(join(root, file));
    } catch {
      continue; // deleted in the working tree
    }
    if (stat.isSymbolicLink()) links.push(file);
    else if (stat.isFile()) files.push(file);
  }
  return { files, links };
}

/**
 * The name `file` gets in the copy. The nginx image renders each
 * `<name>.conf.template` into `<name>.conf` at start (the web image's
 * default.conf.template among them), and Semgrep's nginx rules select `*.conf`
 * files only: under its own name the template would be read by no nginx rule.
 * It keeps its name when a file of the rendered name exists too. Findings and
 * `nosemgrep` comments refer to its lines, which the rename leaves unchanged.
 * @param {string} file
 * @param {ReadonlySet<string>} files every file being copied
 */
export function copyName(file, files) {
  if (!file.endsWith('.conf.template')) return file;
  const rendered = file.slice(0, -'.template'.length);
  return files.has(rendered) ? file : rendered;
}

/**
 * Copies `files` from `root` into a new temporary directory and returns it.
 * @param {string[]} files
 * @param {string} [root]
 */
export function copyToTemp(files, root = process.cwd()) {
  const copy = mkdtempSync(join(tmpdir(), 'sast-'));
  const all = new Set(files);
  try {
    for (const file of files) {
      const target = join(copy, copyName(file, all));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, file), target);
    }
  } catch (error) {
    rmSync(copy, { recursive: true, force: true });
    throw error;
  }
  return copy;
}

/**
 * Scans the repository at `root`: selection, copy, Semgrep, and the copy
 * removed whatever happens. Resolves to Semgrep's exit status, or to 130/143
 * when the scan was interrupted (never to a success it did not finish).
 * @param {{ root?: string; run?: typeof runTool; log?: (line: string) => void }} [options]
 * @returns {Promise<number>}
 */
export async function scan({ root = process.cwd(), run = runTool, log = console.log } = {}) {
  const { files, links } = selectFiles(root);
  const copy = copyToTemp(files, root);
  // An interrupted scan (Ctrl+C, a CI cancel) removes its copy and fails.
  // Node runs signal handlers only between synchronous calls: one that
  // arrives while Docker runs is handled right after it returns (the tick
  // below), before this function returns a status.
  // An object, read after an await, so the compiler does not narrow it.
  /** @type {{ signal: NodeJS.Signals | null }} */
  const interrupted = { signal: null };
  /** @param {NodeJS.Signals} signal */
  const onSignal = (signal) => {
    interrupted.signal = signal;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    log(
      `Semgrep: ${files.length} files${links.length > 0 ? ` (${links.length} symbolic links not followed: ${links.join(', ')})` : ''}.`,
    );
    const all = new Set(files);
    const renamed = files.filter((file) => copyName(file, all) !== file);
    if (renamed.length > 0) {
      log(
        `nginx templates scanned under the name they render to: ${renamed.map((file) => `${file} as ${copyName(file, all)}`).join(', ')}.`,
      );
    }
    // The Semgrep image refuses to run unless the code is mounted at /src.
    const status = run(
      'semgrep',
      [
        'semgrep',
        'scan',
        '--metrics=off',
        '--disable-version-check',
        '--error',
        ...RULESETS.flatMap((ruleset) => ['--config', ruleset]),
      ],
      { mount: '/src', source: copy },
    );
    await new Promise((done) => setImmediate(done));
    if (interrupted.signal !== null) return interrupted.signal === 'SIGINT' ? 130 : 143;
    return status;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    rmSync(copy, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await scan());
}

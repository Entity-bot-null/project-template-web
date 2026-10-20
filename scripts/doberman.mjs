// The helper of `/doberman`, the pull request auditor of this template
// (.claude/skills/doberman/SKILL.md): the parts of an audit that must not
// depend on the model's judgment. Run from the repository root
// (`node scripts/doberman.mjs <command>`); every command prints JSON.
//
//   start [--base <ref>] [--mode default|diff|full|security|tests]
//       Snapshot of the workspace, project detection, pull request scope,
//       gate plan and environment probes. Creates the run directory, outside
//       the repository, and saves context.json and snapshot.json there.
//   sandbox --run <dir>
//       Copy of the workspace (tracked files and new ones git does not
//       ignore, uncommitted changes included) in <run>/sandbox, as a git
//       repository: for builds and experiments that write files.
//   coverage --run <dir>
//       Changed lines that no test executed, from the lcov reports the
//       coverage gate writes.
//   clean --run <dir> [--remove-artifacts]
//       Deletes this run's reproduction files (named *.doberman.* and marked
//       DOBERMAN-TEMPORARY) and sandbox, optionally the gate artifacts that
//       did not exist before the run, then compares the workspace with the
//       snapshot. Exits 1 when something differs.
//   verdict --run <dir>
//       Validates <run>/result.json against the evidence rules (every PASS
//       and FAIL against its gate log, the cleanup done) and computes the
//       verdict. Exits 1 when the result is invalid.
//   status --run <dir>
//       Where a run is: gates finished or never finished, result written,
//       workspace cleaned, verdict computed. An interrupted run says so.
//   help
//
// Options a command does not accept stop it before it touches anything.
//
// Read-only towards the repository: it runs git's read commands only, and
// deletes nothing but its own run directory, files that carry the marker
// and, on request, the gate artifacts listed in template.json that the run
// created. The template-specific knowledge (detection, gates, areas) lives in
// .claude/skills/doberman/template.json; this file is the same in both
// templates (web and mobile).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * @typedef {{ file?: string; anyFile?: string[]; dependency?: string; package?: string }} Signal
 * @typedef {{ name?: string; tags?: string[]; requires?: string[]; isolation?: string; covers?: string }} GateMeta
 * @typedef {{ start: string; stop: string; needs?: string[]; note?: string }} Service
 * @typedef {{ id: string; paths: string[]; focus: string; docs?: string[] }} Area
 * @typedef {{ file: string; base?: string }} LcovReport
 * @typedef {{
 *   id: string;
 *   name: string;
 *   command: string;
 *   commandWindows?: string;
 *   script?: string;
 *   source?: string;
 *   required: boolean;
 *   when: string;
 *   paths?: string[];
 *   tags: string[];
 *   requires: string[];
 *   isolation: string;
 *   covers?: string | null;
 *   note?: string;
 *   missingScript?: boolean;
 *   plan?: Plan;
 * }} Gate
 * @typedef {Omit<Gate, 'tags' | 'requires' | 'isolation'> & Partial<Pick<Gate, 'tags' | 'requires' | 'isolation'>>} ExtraGate
 * @typedef {{
 *   run: boolean;
 *   reason: string;
 *   blockedBy: string[];
 *   notApplicable: boolean;
 *   services: (Service & { requirement: string })[];
 *   triggeredBy: string[];
 * }} Plan
 * @typedef {{
 *   template: string;
 *   displayName: string;
 *   detection: { required: Signal[]; supporting: Signal[]; minSupporting: number };
 *   rules: string[];
 *   prTemplate: string;
 *   aggregateScript: string;
 *   gates?: Record<string, GateMeta>;
 *   extraGates?: ExtraGate[];
 *   services?: Record<string, Service>;
 *   environment?: { databaseEnvFiles?: string[] };
 *   areas?: Area[];
 *   artifacts?: string[];
 *   coverage?: { lcov: LcovReport[]; include: string[]; exclude: string[] };
 *   reproduction?: Record<string, string>;
 * }} Template
 * @typedef {{ available: boolean; detail: string; configured?: boolean }} Probe
 * @typedef {Record<string, Probe>} Probes
 * @typedef {{
 *   path: string;
 *   status: string;
 *   from?: string;
 *   origin: string;
 *   binary?: boolean;
 *   additions?: number | null;
 *   deletions?: number | null;
 * }} FileChange
 * @typedef {{ ref: string; sha: string; source: string }} Base
 * @typedef {{ sha: string; author: string; date: string; subject: string }} Commit
 * @typedef {{ clean: boolean; output: string[] }} DiffCheck
 * @typedef {{
 *   head: string | null;
 *   branch: string | null;
 *   unborn: boolean;
 *   base: Base | null;
 *   mergeBase: string | null;
 *   diffBase: string;
 *   onBaseBranch: boolean;
 *   commits: Commit[];
 *   files: FileChange[];
 *   diffCheck: DiffCheck;
 * }} Scope
 * @typedef {{
 *   projectType: string;
 *   expected: string;
 *   template: string;
 *   confidence: number;
 *   missing: string[];
 * }} Detection
 * @typedef {{
 *   takenAt: string;
 *   head: string | null;
 *   branch: string | null;
 *   index: string;
 *   stashes: number;
 *   entries: Record<string, { code: string; hash: string }>;
 *   artifacts: Record<string, boolean>;
 * }} Snapshot
 * @typedef {{
 *   runDir: string;
 *   root: string;
 *   detection: Detection;
 *   git: Omit<Scope, 'files'> & { files: FileChange[] };
 *   gates: (Gate & { plan: Plan })[];
 * }} Context
 * @typedef {{ id?: string; name?: string; status?: string; evidence?: string; reason?: string }} ResultGate
 * @typedef {{
 *   id?: string;
 *   location?: string;
 *   severity?: string;
 *   verification?: string;
 *   reproductionId?: string;
 *   gate?: string;
 *   [field: string]: unknown;
 * }} Finding
 * @typedef {{ id?: string; status?: string; evidence?: string }} Reproduction
 * @typedef {Record<string, string | boolean>} Options
 */

const SKILL_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.claude',
  'skills',
  'doberman',
);
/** @type {Template} */
const TEMPLATE = JSON.parse(readFileSync(join(SKILL_DIR, 'template.json'), 'utf8'));
const MARKER = 'DOBERMAN-TEMPORARY';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MODES = ['default', 'diff', 'full', 'security', 'tests'];
const GATE_STATUSES = ['PASS', 'FAIL', 'SKIPPED', 'NOT APPLICABLE', 'UNVERIFIED'];
const SEVERITIES = ['BLOCKING', 'SHOULD FIX', 'LOW', 'NIT'];
const VERIFICATIONS = ['REPRODUCED', 'CONFIRMED', 'UNVERIFIED'];
const REPRO_STATUSES = ['REPRODUCED', 'NOT REPRODUCED', 'UNVERIFIABLE'];
const FINDING_FIELDS = [
  'location',
  'problem',
  'whyItMatters',
  'reproduction',
  'evidence',
  'recommendation',
];
const EXIT_MARKER = /^DOBERMAN_EXIT=(\d+)/gm;
const USAGE = `usage: node scripts/doberman.mjs <command> [options]

  start [--base <ref>] [--mode default|diff|full|security|tests]
  sandbox --run <dir>
  coverage --run <dir>
  clean --run <dir> [--remove-artifacts]
  verdict --run <dir>
  status --run <dir>
  help

Gate logs go to <run>/logs/<gate id>.log (":" becomes "-") and end with the
line DOBERMAN_EXIT=<exit code>; verdict checks every reported PASS and FAIL
against it. See .claude/skills/doberman/SKILL.md.`;

// ---------------------------------------------------------------- utilities

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`doberman: ${message}\n`);
  process.exit(2);
}

/** @param {unknown} value */
function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string[]} args
 * @param {{ allowFailure?: boolean; cwd?: string }} [options]
 */
function git(args, { allowFailure = false, cwd } = {}) {
  const run = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error) fail(`git is not available: ${run.error.message}`);
  if (run.status !== 0 && !allowFailure) {
    fail(`git ${args.join(' ')} failed: ${run.stderr.trim()}`);
  }
  return { ok: run.status === 0, status: run.status, out: run.stdout, err: run.stderr };
}

/**
 * @param {string[]} args
 * @param {{ allowFailure?: boolean; cwd?: string }} [options]
 */
function gitList(args, options) {
  return git(args, options)
    .out.split('\0')
    .filter((entry) => entry.length > 0);
}

/**
 * `--name value` and `--flag` arguments, checked against what the command
 * accepts: anything else stops the run before it touches anything.
 * @param {string[]} argv
 * @param {{ values: string[]; flags: string[] }} accepted
 * @returns {Options}
 */
function parseOptions(argv, accepted) {
  /** @type {Options} */
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const name = arg.slice(2);
    if (!arg.startsWith('--')) fail(`unexpected argument "${arg}".\n${USAGE}`);
    if (name in parsed) fail(`--${name} given twice.`);
    if (accepted.flags.includes(name)) {
      parsed[name] = true;
    } else if (accepted.values.includes(name)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value.`);
      parsed[name] = value;
      index += 1;
    } else {
      fail(`unknown option --${name}.\n${USAGE}`);
    }
  }
  return parsed;
}

/** @param {string | Buffer} data */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The digest of a file, read through the descriptor its type was checked on
 * (no window for the path to change between the two). Non-blocking: a FIFO
 * opens at once, and is not a file.
 * @param {string} path
 */
function fileHash(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EISDIR'
      ? 'not-a-file'
      : 'missing';
  }
  try {
    return fstatSync(fd).isFile() ? sha256(readFileSync(fd)) : 'not-a-file';
  } catch {
    return 'missing';
  } finally {
    closeSync(fd);
  }
}

// Glob subset, matched without building regular expressions from the
// patterns: `**` any number of path segments, `*` and `?` within one
// segment, `{a,b}` alternatives.

/**
 * @param {string} glob
 * @returns {string[]}
 */
function expandBraces(glob) {
  const open = glob.indexOf('{');
  const close = glob.indexOf('}', open);
  if (open === -1 || close === -1) return [glob];
  const before = glob.slice(0, open);
  const after = glob.slice(close + 1);
  return glob
    .slice(open + 1, close)
    .split(',')
    .flatMap((alternative) => expandBraces(`${before}${alternative}${after}`));
}

/**
 * One path segment against one pattern segment (`*` any run, `?` one character).
 * @param {string} pattern
 * @param {string} text
 */
function matchSegment(pattern, text) {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      resume = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * @param {string[]} pattern
 * @param {string[]} path
 * @param {number} [p]
 * @param {number} [s]
 * @returns {boolean}
 */
function matchSegments(pattern, path, p = 0, s = 0) {
  const segment = pattern[p];
  if (segment === undefined) return s === path.length;
  if (segment === '**') {
    for (let next = s; next <= path.length; next += 1) {
      if (matchSegments(pattern, path, p + 1, next)) return true;
    }
    return false;
  }
  const part = path[s];
  return (
    part !== undefined && matchSegment(segment, part) && matchSegments(pattern, path, p + 1, s + 1)
  );
}

/**
 * @param {string} path
 * @param {string} glob
 */
function matchesGlob(path, glob) {
  const segments = path.split('/');
  return expandBraces(glob).some((expanded) => matchSegments(expanded.split('/'), segments));
}

/**
 * @param {string} path
 * @param {string[]} [globs]
 */
function matchesAny(path, globs = []) {
  return globs.some((glob) => matchesGlob(path, glob));
}

/**
 * @param {string} path
 * @returns {any} parsed JSON (validated by the caller), or null
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} path */
function isBinary(path) {
  try {
    const head = readFileSync(path).subarray(0, 8000);
    return head.includes(0);
  } catch {
    return true;
  }
}

/** @param {string} path */
function lineCount(path) {
  try {
    const text = readFileSync(path, 'utf8');
    if (text.length === 0) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

/**
 * @param {readonly string[]} list
 * @param {unknown} value
 */
function isOneOf(list, value) {
  return typeof value === 'string' && list.includes(value);
}

/**
 * Windows compares paths without regard to case: c:\x and C:\x are one directory.
 * @param {string} path
 */
function normalized(path) {
  return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
}

/**
 * @param {string} a
 * @param {string} b
 */
function samePath(a, b) {
  return normalized(a) === normalized(b);
}

/**
 * @param {string} path
 * @param {string} parent
 */
function isInside(path, parent) {
  return normalized(path).startsWith(normalized(parent) + sep);
}

function runsRoot() {
  return resolve(process.env.DOBERMAN_TMP ?? join(tmpdir(), 'doberman'));
}

/**
 * The runs' parent directory, created private: refused when it is a link,
 * belongs to someone else, or others may write into it (the system's
 * temporary directory is shared).
 */
function privateRunsRoot() {
  const dir = runsRoot();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  const mine = typeof process.getuid !== 'function' || stats.uid === process.getuid();
  const sharedWrite = process.platform !== 'win32' && (stats.mode & 0o022) !== 0;
  if (!stats.isDirectory() || !mine || sharedWrite) {
    fail(`${dir} is not a private directory of yours: set DOBERMAN_TMP to one.`);
  }
  return dir;
}

/** @param {Options} opts */
function runDirFrom(opts) {
  const dir = opts.run;
  if (typeof dir !== 'string') fail('--run <dir> is required (printed by `start`).');
  const absolute = resolve(dir);
  if (!isInside(absolute, runsRoot()) || !existsSync(join(absolute, 'context.json'))) {
    fail(`${dir} is not a doberman run directory.`);
  }
  return absolute;
}

/**
 * @param {string} runDir
 * @returns {Context}
 */
function readContext(runDir) {
  return readJson(join(runDir, 'context.json'));
}

/**
 * The commands that delete or copy files act on the repository the run was
 * started in, from its root, and on nothing else.
 * @param {Context} context
 */
function assertRunRoot(context) {
  if (!samePath(process.cwd(), context.root)) {
    fail(`this run belongs to ${context.root}: run the command from that repository's root.`);
  }
}

/** @param {string} path */
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** What a secret looks like in text the report is built from. */
const SECRET_SHAPES = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['an AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['a JSON Web Token', /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/],
  ['credentials in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/@"']+@/i],
];

/**
 * Secrets in `text`: the shapes above, and the values of the repository's
 * local .env files whose names say they are secret. Returns what was found,
 * never the value itself.
 * @param {string} text
 * @param {string} root
 */
function secretsIn(text, root) {
  /** @type {string[]} */
  const found = SECRET_SHAPES.filter(([, shape]) => /** @type {RegExp} */ (shape).test(text)).map(
    ([label]) => String(label),
  );
  const envFiles = ['.env', '.env.local'];
  for (const parent of ['apps', 'packages']) {
    if (existsSync(join(root, parent))) {
      for (const entry of readdirSync(join(root, parent)))
        envFiles.push(join(parent, entry, '.env'));
    }
  }
  for (const file of envFiles) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    let values;
    try {
      values = parseEnv(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    for (const [name, value] of Object.entries(values)) {
      if (
        /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|DSN/i.test(name) &&
        typeof value === 'string' &&
        value.length >= 8 &&
        text.includes(value)
      ) {
        found.push(`the value of ${name} from ${file}`);
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------- detection

/**
 * @param {string} root
 * @param {string} [path]
 * @returns {any}
 */
function packageJson(root, path = 'package.json') {
  return readJson(join(root, path)) ?? {};
}

/**
 * @param {string} root
 * @param {string} name
 * @param {string} [path]
 */
function hasDependency(root, name, path) {
  const pkg = packageJson(root, path);
  return Boolean(
    pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.peerDependencies?.[name],
  );
}

/**
 * @param {string} root
 * @param {Signal} signal
 */
function checkSignal(root, signal) {
  if (signal.file) return existsSync(join(root, signal.file));
  if (signal.anyFile) return signal.anyFile.some((file) => existsSync(join(root, file)));
  if (signal.dependency) return hasDependency(root, signal.dependency, signal.package);
  return false;
}

/** @param {Signal} signal */
function describeSignal(signal) {
  if (signal.file) return `file ${signal.file}`;
  if (signal.anyFile) return `one of ${signal.anyFile.join(', ')}`;
  return `dependency ${signal.dependency ?? '?'}${signal.package ? ` (${signal.package})` : ''}`;
}

/**
 * @param {string} root
 * @returns {Detection}
 */
function detect(root) {
  const { required, supporting, minSupporting } = TEMPLATE.detection;
  const requiredResults = required.map((signal) => ({
    signal: describeSignal(signal),
    found: checkSignal(root, signal),
  }));
  const supportingResults = supporting.map((signal) => ({
    signal: describeSignal(signal),
    found: checkSignal(root, signal),
  }));
  const supportingRatio =
    supportingResults.filter((result) => result.found).length /
    Math.max(supportingResults.length, 1);
  const matches =
    requiredResults.every((result) => result.found) && supportingRatio >= minSupporting;
  return {
    projectType: matches ? TEMPLATE.template : 'UNKNOWN',
    expected: TEMPLATE.template,
    template: TEMPLATE.displayName,
    confidence: Number(
      (
        (requiredResults.filter((result) => result.found).length / required.length) * 0.5 +
        supportingRatio * 0.5
      ).toFixed(2),
    ),
    missing: [...requiredResults, ...supportingResults]
      .filter((result) => !result.found)
      .map((result) => result.signal),
  };
}

// ---------------------------------------------------------------- git scope

/** @param {string} ref */
function resolveRef(ref) {
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    allowFailure: true,
  });
  return result.ok ? result.out.trim() : null;
}

/** @param {string} root */
function inProgressOperation(root) {
  const gitDir = resolve(root, git(['rev-parse', '--git-dir']).out.trim());
  const markers = {
    merge: 'MERGE_HEAD',
    rebase: 'rebase-merge',
    'rebase (apply)': 'rebase-apply',
    'cherry-pick': 'CHERRY_PICK_HEAD',
    revert: 'REVERT_HEAD',
    bisect: 'BISECT_LOG',
  };
  for (const [name, marker] of Object.entries(markers)) {
    if (existsSync(join(gitDir, marker))) return name;
  }
  return null;
}

/**
 * @param {string | boolean | undefined} requested
 * @param {string | null} branch
 * @returns {Base | null}
 */
function chooseBase(requested, branch) {
  if (requested === true) fail('--base needs a ref: --base <branch or commit>.');
  if (typeof requested === 'string') {
    const sha = resolveRef(requested);
    if (sha === null) fail(`--base ${requested} is not a commit in this repository.`);
    return { ref: requested, sha, source: 'argument' };
  }
  const remoteHead = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    allowFailure: true,
  });
  const candidates = [
    ...(remoteHead.ok ? [remoteHead.out.trim()] : []),
    'origin/main',
    'main',
    'origin/master',
    'master',
  ];
  for (const ref of candidates) {
    if (ref === branch) continue;
    const sha = resolveRef(ref);
    if (sha !== null) return { ref, sha, source: 'default branch' };
  }
  // On main itself, or a repository without a remote: the base is the branch.
  for (const ref of ['main', 'master']) {
    const sha = resolveRef(ref);
    if (sha !== null) return { ref, sha, source: 'current branch' };
  }
  return null;
}

/**
 * The entries of a `git diff -z --name-status` output.
 * @param {string[]} entries
 * @returns {FileChange[]}
 */
function parseNameStatus(entries) {
  /** @type {FileChange[]} */
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const status = entries[index] ?? '';
    const kind = status.charAt(0);
    if (kind === 'R' || kind === 'C') {
      const from = entries[index + 1];
      const path = entries[index + 2];
      if (path !== undefined) files.push({ status: kind, path, origin: '', ...(from && { from }) });
      index += 2;
    } else {
      const path = entries[index + 1];
      if (path !== undefined) files.push({ status: kind, path, origin: '' });
      index += 1;
    }
  }
  return files;
}

/** @param {string[]} args */
function numstat(args) {
  /** @type {Map<string, { additions: number | null; deletions: number | null }>} */
  const stats = new Map();
  const entries = git(['diff', '--numstat', '-z', '-M', ...args]).out.split('\0');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry === '') continue;
    const [added, deleted, path] = entry.split('\t');
    // Renames: "a\td\t" followed by the old and the new path.
    const target = path === '' ? entries[index + 2] : path;
    if (path === '') index += 2;
    if (target === undefined) continue;
    stats.set(target, {
      additions: added === undefined || added === '-' ? null : Number(added),
      deletions: deleted === undefined || deleted === '-' ? null : Number(deleted),
    });
  }
  return stats;
}

/** @param {string[]} args */
function diffCheck(args) {
  const result = git(['diff', '--check', ...args], { allowFailure: true });
  return { clean: result.status === 0, output: result.out.trim().split('\n').slice(0, 50) };
}

/**
 * @param {string} root
 * @param {Options} opts
 * @returns {Scope}
 */
function scope(root, opts) {
  const head = resolveRef('HEAD');
  const branchResult = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowFailure: true,
  });
  const branch = branchResult.ok ? branchResult.out.trim() : null;
  const untracked = gitList(['ls-files', '-z', '--others', '--exclude-standard']);

  if (head === null) {
    // No commit yet: everything staged or new is the change.
    const staged = gitList(['diff', '--cached', '--name-only', '-z', EMPTY_TREE]);
    const paths = [...new Set([...staged, ...untracked])].sort();
    const files = paths.map((path) => {
      const binary = isBinary(join(root, path));
      return {
        path,
        status: 'A',
        origin: staged.includes(path) ? 'staged' : 'untracked',
        binary,
        additions: binary ? null : lineCount(join(root, path)),
        deletions: 0,
      };
    });
    return {
      head: null,
      branch,
      unborn: true,
      base: null,
      mergeBase: null,
      diffBase: EMPTY_TREE,
      onBaseBranch: false,
      commits: [],
      files,
      diffCheck: diffCheck(['--cached', EMPTY_TREE]),
    };
  }

  const base = chooseBase(opts.base, branch);
  const onBaseBranch = base !== null && (base.sha === head || base.ref === branch);
  const mergeBase =
    base === null ? null : git(['merge-base', base.sha, 'HEAD'], { allowFailure: true });
  const mergeBaseSha = mergeBase?.ok ? mergeBase.out.trim() : null;
  const diffBase = mergeBaseSha ?? head;

  const commits =
    mergeBaseSha === null
      ? []
      : git(['log', '--format=%H%x1f%an%x1f%aI%x1f%s', `${mergeBaseSha}..HEAD`])
          .out.split('\n')
          .filter(Boolean)
          .map((line) => {
            const [sha = '', author = '', date = '', subject = ''] = line.split('\x1f');
            return { sha, author, date, subject };
          });

  const committed =
    mergeBaseSha === null
      ? []
      : parseNameStatus(gitList(['diff', '-z', '--name-status', '-M', mergeBaseSha, 'HEAD']));
  const uncommitted = parseNameStatus(gitList(['diff', '-z', '--name-status', '-M', 'HEAD']));
  const stats = numstat([diffBase]);

  /** @type {Map<string, FileChange>} */
  const byPath = new Map();
  for (const file of committed) byPath.set(file.path, { ...file, origin: 'committed' });
  for (const file of uncommitted) {
    const previous = byPath.get(file.path);
    byPath.set(file.path, {
      ...file,
      status: previous?.status === 'A' ? 'A' : file.status,
      origin: previous ? 'committed+uncommitted' : 'uncommitted',
    });
  }
  for (const path of untracked) byPath.set(path, { path, status: 'A', origin: 'untracked' });

  const files = [...byPath.values()]
    .map((file) => {
      const stat = stats.get(file.path);
      const binary = file.status !== 'D' && isBinary(join(root, file.path));
      const untrackedFile = file.origin === 'untracked';
      return {
        ...file,
        binary,
        additions: untrackedFile
          ? binary
            ? null
            : lineCount(join(root, file.path))
          : (stat?.additions ?? null),
        deletions: untrackedFile ? 0 : (stat?.deletions ?? null),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    head,
    branch,
    unborn: false,
    base,
    mergeBase: mergeBaseSha,
    diffBase,
    onBaseBranch,
    commits,
    files,
    diffCheck: diffCheck([diffBase]),
  };
}

// ---------------------------------------------------------------- snapshot

/**
 * @param {string} root
 * @returns {Snapshot}
 */
function snapshot(root) {
  const head = resolveRef('HEAD');
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
  const status = gitList(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  /** @type {Snapshot['entries']} */
  const entries = {};
  for (let index = 0; index < status.length; index += 1) {
    const entry = status[index] ?? '';
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.startsWith('R') || code.startsWith('C')) index += 1; // the origin path
    entries[path] = { code, hash: fileHash(join(root, path)) };
  }
  return {
    takenAt: new Date().toISOString(),
    head,
    branch: branch.ok ? branch.out.trim() : null,
    index: sha256(git(['ls-files', '--stage', '-z']).out),
    stashes: git(['stash', 'list'], { allowFailure: true }).out.split('\n').filter(Boolean).length,
    entries,
    artifacts: Object.fromEntries(
      (TEMPLATE.artifacts ?? []).map((path) => [path, existsSync(join(root, path))]),
    ),
  };
}

/**
 * @param {Snapshot} before
 * @param {Snapshot} after
 */
function compareSnapshots(before, after) {
  /** @type {string[]} */
  const differences = [];
  if (before.head !== after.head) {
    differences.push(`HEAD moved: ${before.head ?? 'none'} → ${after.head ?? 'none'}`);
  }
  if (before.branch !== after.branch) {
    differences.push(`branch changed: ${before.branch ?? 'none'} → ${after.branch ?? 'none'}`);
  }
  if (before.index !== after.index) differences.push('the git index (staged changes) changed');
  if (before.stashes !== after.stashes) {
    differences.push(`stash entries: ${before.stashes} → ${after.stashes}`);
  }
  const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  for (const path of [...paths].sort()) {
    const was = before.entries[path];
    const is = after.entries[path];
    if (was === undefined) differences.push(`new: ${path} (${is?.code.trim() ?? '?'})`);
    else if (is === undefined) differences.push(`no longer changed or gone: ${path}`);
    else if (was.code !== is.code || was.hash !== is.hash) differences.push(`modified: ${path}`);
  }
  return differences;
}

// ---------------------------------------------------------------- gates

/**
 * The scripts an aggregate script (`pnpm a && pnpm b`) runs; null for other commands.
 * @param {string} command
 */
function pnpmScripts(command) {
  return command
    .split('&&')
    .map((part) => part.trim())
    .map((part) => /^pnpm (?:run )?([\w:.-]+)$/.exec(part)?.[1] ?? null);
}

/**
 * @param {string} root
 * @param {FileChange[]} files
 * @param {string} mode
 * @param {Probes} probes
 * @param {boolean} unborn
 */
function discoverGates(root, files, mode, probes, unborn) {
  /** @type {Record<string, string>} */
  const scripts = packageJson(root).scripts ?? {};
  const changed = files.map((file) => file.path);
  /** @type {Gate[]} */
  const gates = [];

  const aggregate = TEMPLATE.aggregateScript;
  const aggregateCommand = scripts[aggregate];
  const fromAggregate = aggregateCommand === undefined ? [] : pnpmScripts(aggregateCommand);
  const known = TEMPLATE.gates ?? {};

  for (const script of fromAggregate) {
    if (script === null) continue;
    const meta = known[script] ?? {};
    gates.push({
      id: script,
      name: meta.name ?? script,
      command: `pnpm ${script}`,
      source: `package.json "${aggregate}"`,
      required: true,
      when: 'always',
      tags: meta.tags ?? [],
      requires: meta.requires ?? [],
      isolation: meta.isolation ?? 'workspace',
      covers: meta.covers ?? null,
    });
  }
  if (aggregateCommand === undefined) {
    gates.push({
      id: aggregate,
      name: `${aggregate} (aggregate)`,
      command: `pnpm ${aggregate}`,
      source: 'template.json',
      required: true,
      when: 'always',
      tags: [],
      requires: [],
      isolation: 'workspace',
      missingScript: true,
    });
  }
  for (const extra of TEMPLATE.extraGates ?? []) {
    gates.push({
      tags: [],
      requires: [],
      isolation: 'workspace',
      ...extra,
      command:
        process.platform === 'win32' && extra.commandWindows ? extra.commandWindows : extra.command,
    });
  }

  for (const gate of gates) {
    if (gate.script !== undefined && scripts[gate.script] === undefined) gate.missingScript = true;
    const triggeredBy =
      gate.when === 'paths' ? changed.filter((path) => matchesAny(path, gate.paths)) : [];
    const missing = gate.requires.filter(
      (requirement) =>
        !['commits', 'sandbox'].includes(requirement) && probes[requirement]?.available !== true,
    );
    // A missing service the template knows how to start (a database in
    // Docker) is not a blocker: the plan says how to start and stop it.
    /** @type {Plan['services']} */
    const services = [];
    for (const requirement of missing) {
      const service = TEMPLATE.services?.[requirement];
      if (
        service !== undefined &&
        probes[requirement]?.configured !== false &&
        (service.needs ?? []).every((need) => probes[need]?.available === true)
      ) {
        services.push({ requirement, ...service });
      }
    }
    const blocked = missing.filter(
      (requirement) => !services.some((service) => service.requirement === requirement),
    );
    let run = false;
    let reason;
    let notApplicable = false;
    if (gate.missingScript) {
      reason = `script "${gate.script ?? gate.id}" is not in package.json`;
      notApplicable = true;
    } else if (gate.requires.includes('commits') && unborn) {
      reason = 'no commits yet: no history to scan (the tree is covered by the other gates)';
      notApplicable = true;
    } else if (mode === 'diff') {
      reason = 'not requested (--diff reviews the code only)';
    } else if (mode === 'security' && !gate.tags.includes('security')) {
      reason = 'not requested (--security)';
    } else if (mode === 'tests' && !gate.tags.includes('tests')) {
      reason = 'not requested (--tests)';
    } else if (gate.when === 'full' && mode !== 'full') {
      reason = 'runs with --full only';
      notApplicable = true;
    } else if (gate.when === 'paths' && triggeredBy.length === 0 && mode !== 'full') {
      reason = 'the change touches none of its paths';
      notApplicable = true;
    } else {
      run = true;
      reason =
        gate.when === 'paths' && triggeredBy.length > 0
          ? `the change touches ${triggeredBy.slice(0, 3).join(', ')}${triggeredBy.length > 3 ? '…' : ''}`
          : 'mandatory';
    }
    gate.plan = {
      run: run && blocked.length === 0,
      reason: run && blocked.length > 0 ? `environment lacks: ${blocked.join(', ')}` : reason,
      blockedBy: run ? blocked : [],
      notApplicable,
      services: run && blocked.length === 0 ? services : [],
      triggeredBy: triggeredBy.slice(0, 20),
    };
  }
  return gates;
}

// ---------------------------------------------------------------- environment

/** @param {string} name */
function onPath(name) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (dir !== '' && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Executables only (no shell): .cmd and .bat shims are reported by onPath.
 * @param {string} command
 * @param {string[]} args
 * @param {number} [timeout]
 */
function probeCommand(command, args, timeout = 15_000) {
  const run = spawnSync(command, args, { encoding: 'utf8', timeout });
  return {
    ok: run.error === undefined && run.status === 0,
    out: `${run.stdout ?? ''}${run.stderr ?? ''}`,
  };
}

/**
 * @param {string} host
 * @param {number} port
 * @param {number} [timeout]
 * @returns {Promise<boolean>}
 */
function tcpReachable(host, port, timeout = 3000) {
  return new Promise((done) => {
    const socket = connect({ host, port });
    /** @param {boolean} value */
    const finish = (value) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeout, () => {
      finish(false);
    });
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}

/** @param {string} root */
function databaseUrl(root) {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of TEMPLATE.environment?.databaseEnvFiles ?? []) {
    const path = join(root, file);
    if (existsSync(path)) {
      const value = parseEnv(readFileSync(path, 'utf8')).DATABASE_URL;
      if (value) return value;
    }
  }
  return null;
}

function playwrightChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'ms-playwright')
      : null,
    process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'ms-playwright') : null,
    join(homedir(), '.cache', 'ms-playwright'),
  ].filter((dir) => typeof dir === 'string');
  return roots.some(
    (dir) => existsSync(dir) && readdirSync(dir).some((entry) => entry.startsWith('chromium')),
  );
}

/**
 * @param {string} root
 * @returns {Promise<Probes>}
 */
async function probeEnvironment(root) {
  const wanted = new Set(
    [
      ...Object.values(TEMPLATE.gates ?? {}).flatMap((gate) => gate.requires ?? []),
      ...(TEMPLATE.extraGates ?? []).flatMap((gate) => gate.requires ?? []),
      'gh',
    ].filter((name) => !['commits', 'sandbox'].includes(name)),
  );
  /** @type {Probes} */
  const probes = {};

  if (wanted.has('docker')) {
    const docker = onPath('docker')
      ? probeCommand('docker', ['info', '--format', '{{.ServerVersion}}'])
      : null;
    probes.docker = {
      available: docker?.ok === true,
      detail:
        docker === null
          ? 'docker not on PATH'
          : docker.ok
            ? `server ${docker.out.trim()}`
            : 'daemon not running',
    };
  }
  if (wanted.has('network')) {
    try {
      await lookup('registry.npmjs.org');
      probes.network = { available: true, detail: 'registry.npmjs.org resolves' };
    } catch {
      probes.network = { available: false, detail: 'registry.npmjs.org does not resolve' };
    }
  }
  if (wanted.has('database')) {
    const url = databaseUrl(root);
    if (url === null) {
      probes.database = {
        available: false,
        configured: false,
        detail: `DATABASE_URL not set (environment or ${(TEMPLATE.environment?.databaseEnvFiles ?? []).join(', ')})`,
      };
    } else {
      const parsed = new URL(url);
      const port = Number(parsed.port || 5432);
      const reachable = await tcpReachable(parsed.hostname, port);
      probes.database = {
        available: reachable,
        configured: true,
        detail: `${parsed.hostname}:${port} ${reachable ? 'accepts connections' : 'not reachable'}`,
      };
    }
  }
  if (wanted.has('browser')) {
    const installed = playwrightChromium();
    probes.browser = {
      available: installed,
      detail: installed ? 'Playwright Chromium installed' : 'Playwright Chromium not installed',
    };
  }
  if (wanted.has('android')) {
    // The SDK's default locations when ANDROID_HOME is not set (Android Studio installs).
    const sdks = [
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      process.platform === 'win32' && process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
        : null,
      process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Android', 'sdk')
        : join(homedir(), 'Android', 'Sdk'),
    ].filter((sdk) => typeof sdk === 'string');
    const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
    const adb =
      onPath('adb') ??
      sdks.map((sdk) => join(sdk, 'platform-tools', executable)).find((path) => existsSync(path)) ??
      null;
    const devices = adb === null ? null : probeCommand(adb, ['devices']);
    const attached = devices?.ok
      ? devices.out.split('\n').filter((line) => /\tdevice$/.test(line.trim()))
      : [];
    probes.android = {
      available: attached.length > 0,
      detail:
        adb === null ? 'adb not found' : `${attached.length} device(s) or emulator(s) attached`,
    };
  }
  if (wanted.has('jdk17')) {
    // Gradle uses JAVA_HOME first, then the java on PATH.
    const fromHome = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
      : null;
    const javaPath = fromHome !== null && existsSync(fromHome) ? fromHome : onPath('java');
    const java = javaPath === null ? null : probeCommand(javaPath, ['-version']);
    const major = /version "(\d+)/.exec(java?.out ?? '')?.[1];
    probes.jdk17 = {
      available: major === '17',
      detail: major
        ? `java ${major} at ${javaPath ?? '?'} (React Native builds need 17)`
        : 'no java in JAVA_HOME or on PATH',
    };
  }
  if (wanted.has('maestro')) {
    const home = join(homedir(), '.maestro', 'bin');
    const maestro = onPath('maestro') ?? (existsSync(home) ? home : null);
    probes.maestro = { available: maestro !== null, detail: maestro ?? 'maestro not installed' };
  }
  if (wanted.has('ios')) {
    const xcode =
      process.platform === 'darwin' && onPath('xcodebuild')
        ? probeCommand('xcodebuild', ['-version'])
        : null;
    probes.ios = {
      available: xcode?.ok === true,
      detail:
        process.platform !== 'darwin'
          ? 'requires macOS with Xcode'
          : xcode?.ok
            ? (xcode.out.split('\n')[0] ?? 'Xcode')
            : 'Xcode not found',
    };
  }
  const gh = onPath('gh');
  probes.gh = { available: gh !== null, detail: gh ?? 'GitHub CLI not installed' };
  return probes;
}

/**
 * Whether this Node.js satisfies package.json `engines.node` (ranges made of
 * `^x.y.z`, `~x.y.z`, `>=x.y.z` and exact versions, joined by `||`). Gates
 * run with another Node fail for the wrong reason.
 * @param {unknown} range
 */
function nodeEngines(range) {
  if (typeof range !== 'string')
    return { required: null, satisfied: true, detail: 'no engines.node' };
  /** @param {string} version */
  const parts = (version) => version.replace(/^v/, '').split('.').map(Number);
  const [major = 0, minor = 0, patch = 0] = parts(process.version);
  /** @param {number[]} target */
  const atLeast = ([a = 0, b = 0, c = 0]) =>
    major > a || (major === a && (minor > b || (minor === b && patch >= c)));
  let understood = true;
  const satisfied = range.split('||').some((alternative) => {
    const clause = alternative.trim();
    const match = /^(\^|~|>=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(clause);
    if (match === null) {
      understood = false;
      return false;
    }
    const target = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
    if (match[1] === '>=') return atLeast(target);
    if (match[1] === '^') return major === target[0] && atLeast(target);
    if (match[1] === '~') return major === target[0] && minor === target[1] && atLeast(target);
    return major === target[0] && minor === target[1] && patch === target[2];
  });
  return {
    required: range,
    satisfied: satisfied || !understood,
    detail: satisfied
      ? `${process.version} satisfies ${range}`
      : understood
        ? `${process.version} does not satisfy ${range}: switch to a matching Node.js before running gates`
        : `could not read ${range}: check the Node.js version by hand`,
  };
}

// ---------------------------------------------------------------- areas

/** @param {FileChange[]} files */
function touchedAreas(files) {
  return (TEMPLATE.areas ?? [])
    .map((area) => ({
      id: area.id,
      focus: area.focus,
      docs: area.docs ?? [],
      files: files.filter((file) => matchesAny(file.path, area.paths)).map((file) => file.path),
    }))
    .filter((area) => area.files.length > 0);
}

// ---------------------------------------------------------------- commands

/** @param {Options} opts */
async function start(opts) {
  const top = git(['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!top.ok) fail('not inside a git repository.');
  const root = resolve(top.out.trim());
  if (!samePath(process.cwd(), root)) fail(`run from the repository root: ${root}`);
  const mode = typeof opts.mode === 'string' ? opts.mode : 'default';
  if (!MODES.includes(mode)) fail(`--mode must be one of ${MODES.join(', ')}.`);

  const before = snapshot(root);
  const detection = detect(root);
  const operation = inProgressOperation(root);
  const prScope = scope(root, opts);
  const effectiveMode = prScope.unborn && mode === 'default' ? 'full' : mode;
  const probes = await probeEnvironment(root);
  const gates =
    detection.projectType === 'UNKNOWN'
      ? []
      : discoverGates(root, prScope.files, effectiveMode, probes, prScope.unborn);

  // A new private directory every time (mkdtemp: created by this call, mode
  // 0700): never one that already exists or someone else prepared.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = mkdtempSync(join(privateRunsRoot(), `${basename(root)}-${stamp}-`));
  mkdirSync(join(runDir, 'logs'));

  const totals = prScope.files.reduce(
    (sum, file) => ({
      additions: sum.additions + (file.additions ?? 0),
      deletions: sum.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );
  const context = {
    runDir,
    logDir: join(runDir, 'logs'),
    root,
    mode: effectiveMode,
    requestedMode: mode,
    detection,
    blockers: [
      ...(detection.projectType === 'UNKNOWN'
        ? [
            `not a ${TEMPLATE.displayName} repository: stop (missing: ${detection.missing.join('; ')})`,
          ]
        : []),
      ...(operation ? [`a ${operation} is in progress: finish or abort it first`] : []),
      ...(!prScope.unborn && prScope.base !== null && prScope.mergeBase === null
        ? [
            `HEAD and ${prScope.base.ref} share no history (no merge base): the branch's changes cannot be scoped; pass --base <ref> with a related branch`,
          ]
        : []),
      ...(!prScope.unborn && prScope.base === null
        ? ['no base branch found (no main, master or origin/HEAD): pass --base <ref>']
        : []),
      ...(!prScope.unborn && prScope.files.length === 0 && effectiveMode !== 'full'
        ? [
            'nothing to review: no commits since the base and no uncommitted changes (`/doberman --full` audits the whole repository)',
          ]
        : []),
    ],
    rules: [...TEMPLATE.rules, TEMPLATE.prTemplate].filter((path) => existsSync(join(root, path))),
    git: {
      branch: prScope.branch,
      head: prScope.head,
      unborn: prScope.unborn,
      base: prScope.base,
      mergeBase: prScope.mergeBase,
      diffBase: prScope.diffBase,
      onBaseBranch: prScope.onBaseBranch,
      commits: prScope.commits,
      diffCheck: prScope.diffCheck,
      stats: {
        files: prScope.files.length,
        added: prScope.files.filter((file) => file.status === 'A').length,
        modified: prScope.files.filter((file) => file.status === 'M').length,
        deleted: prScope.files.filter((file) => file.status === 'D').length,
        renamed: prScope.files.filter((file) => file.status === 'R').length,
        ...totals,
      },
      uncommitted: prScope.files.filter((file) => file.origin !== 'committed').length,
      files: prScope.files,
    },
    areas: touchedAreas(prScope.files),
    gates,
    environment: {
      platform: process.platform,
      node: process.version,
      nodeEngines: nodeEngines(packageJson(root).engines?.node),
      ...probes,
    },
    artifacts: TEMPLATE.artifacts ?? [],
    reproduction: TEMPLATE.reproduction,
  };
  writeFileSync(join(runDir, 'snapshot.json'), JSON.stringify(before, null, 2));
  writeFileSync(join(runDir, 'context.json'), JSON.stringify(context, null, 2));

  // The full file list stays in context.json: large changes would flood the output.
  print({
    ...context,
    git: {
      ...context.git,
      files: context.git.files.slice(0, 200),
      filesTruncated: Math.max(context.git.files.length - 200, 0),
    },
  });
}

/** @param {Options} opts */
function sandbox(opts) {
  const runDir = runDirFrom(opts);
  const context = readContext(runDir);
  assertRunRoot(context);
  const target = join(runDir, 'sandbox');
  if (existsSync(target)) fail(`${target} exists already: one sandbox per run.`);
  const files = gitList(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: context.root,
  });
  let copied = 0;
  /** @type {string[]} */
  const skippedLinks = [];
  for (const file of files) {
    const from = join(context.root, file);
    if (!existsSync(from)) continue; // deleted in the worktree
    // A link is never followed: one pointing outside the repository would
    // copy files the change does not contain (keys, other projects).
    if (isLink(from)) {
      skippedLinks.push(file);
      continue;
    }
    if (!statSync(from).isFile()) continue;
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(from, join(target, file));
    copied += 1;
  }
  git(['init', '--quiet', '--initial-branch', context.git.branch ?? 'main'], { cwd: target });
  git(['add', '--all'], { cwd: target });
  git(
    [
      '-c',
      'user.name=doberman',
      '-c',
      'user.email=doberman@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--no-verify',
      '--message',
      'doberman sandbox: the audited working tree',
    ],
    { cwd: target },
  );
  print({ sandbox: target, files: copied, skippedLinks });
}

/**
 * @param {string} root
 * @param {string} diffBase
 * @param {FileChange} file
 */
function addedLines(root, diffBase, file) {
  if (file.origin === 'untracked' || diffBase === EMPTY_TREE || file.status === 'A') {
    const count = lineCount(join(root, file.path));
    return Array.from({ length: count }, (_, index) => index + 1);
  }
  const diff = git(['diff', '-U0', '--no-color', diffBase, '--', file.path], { cwd: root }).out;
  /** @type {number[]} */
  const lines = [];
  for (const match of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const startLine = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = startLine; line < startLine + count; line += 1) lines.push(line);
  }
  return lines;
}

/**
 * @param {string} root
 * @param {LcovReport} report
 */
function readLcov(root, report) {
  const path = join(root, report.file);
  if (!existsSync(path)) return null;
  /** @type {Map<string, Map<number, number>>} */
  const coverage = new Map();
  /** @type {Map<number, number> | null} */
  let current = null;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const source = line.slice(3);
      const absolute = isAbsolute(source) ? source : join(root, report.base ?? '.', source);
      current = new Map();
      coverage.set(relative(root, absolute).split(sep).join('/'), current);
    } else if (line.startsWith('DA:') && current) {
      const [lineNumber, hits] = line.slice(3).split(',');
      current.set(Number(lineNumber), Number(hits));
    } else if (line === 'end_of_record') {
      current = null;
    }
  }
  return coverage;
}

/** @param {number[]} numbers */
function ranges(numbers) {
  /** @type {[number, number][]} */
  const result = [];
  for (const number of numbers) {
    const last = result.at(-1);
    if (last && number === last[1] + 1) last[1] = number;
    else result.push([number, number]);
  }
  return result.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`));
}

/** @param {Options} opts */
function coverage(opts) {
  const runDir = runDirFrom(opts);
  const context = readContext(runDir);
  const { root } = context;
  const config = TEMPLATE.coverage ?? { lcov: [], include: [], exclude: [] };
  /** @type {Map<string, Map<number, number>>} */
  const reports = new Map();
  /** @type {string[]} */
  const missingReports = [];
  for (const report of config.lcov) {
    const parsed = readLcov(root, report);
    if (parsed === null) missingReports.push(report.file);
    else for (const [path, data] of parsed) reports.set(path, data);
  }
  /** @type {{ path: string; changedLines: number; measured: boolean; executableChangedLines?: number; uncoveredChangedLines?: number; uncovered?: string[] }[]} */
  const files = [];
  for (const file of context.git.files) {
    if (file.status === 'D' || file.binary === true) continue;
    if (!matchesAny(file.path, config.include) || matchesAny(file.path, config.exclude)) continue;
    const changed = addedLines(root, context.git.diffBase, file);
    const measured = reports.get(file.path);
    if (measured === undefined) {
      files.push({ path: file.path, changedLines: changed.length, measured: false });
      continue;
    }
    const executable = changed.filter((line) => measured.has(line));
    const uncovered = executable.filter((line) => measured.get(line) === 0);
    files.push({
      path: file.path,
      changedLines: changed.length,
      measured: true,
      executableChangedLines: executable.length,
      uncoveredChangedLines: uncovered.length,
      uncovered: ranges(uncovered),
    });
  }
  const executable = files.reduce((sum, file) => sum + (file.executableChangedLines ?? 0), 0);
  const uncovered = files.reduce((sum, file) => sum + (file.uncoveredChangedLines ?? 0), 0);
  const result = {
    reports: config.lcov.map((report) => report.file),
    missingReports,
    note:
      missingReports.length > 0
        ? 'Run the coverage gate first: some reports are missing.'
        : 'Lines are the changed lines that the instrumented code can execute.',
    changedExecutableLines: executable,
    uncoveredChangedLines: uncovered,
    changedLineCoverage:
      executable === 0 ? null : Number(((1 - uncovered / executable) * 100).toFixed(1)),
    files,
  };
  writeFileSync(join(runDir, 'coverage.json'), JSON.stringify(result, null, 2));
  print(result);
}

/** @param {string} path */
function isMarkedTemporary(path) {
  try {
    return readFileSync(path, 'utf8').slice(0, 400).includes(MARKER);
  } catch {
    return false;
  }
}

/** @param {Options} opts */
function clean(opts) {
  const runDir = runDirFrom(opts);
  const context = readContext(runDir);
  assertRunRoot(context);
  /** @type {Snapshot} */
  const before = readJson(join(runDir, 'snapshot.json'));
  const { root } = context;
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const leftovers = [];
  /** @type {string[]} */
  const failures = [];

  // A failed deletion (a file another process holds open on Windows) is
  // reported and leaves the run not clean; it never aborts the cleanup.
  /**
   * @param {string} path
   * @param {string} label
   */
  const remove = (path, label) => {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 });
      return true;
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  for (const path of gitList(['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root })) {
    if (!basename(path).includes('.doberman.')) continue;
    if (before.entries[path] !== undefined) {
      // Not this run's: only what the run created is deleted.
      leftovers.push(`${path}: existed before this run; not deleted (remove it if it is yours)`);
    } else if (isLink(join(root, path))) {
      leftovers.push(`${path}: a symbolic link; never deleted by doberman`);
    } else if (!isMarkedTemporary(join(root, path))) {
      leftovers.push(
        `${path}: named like a doberman file but without the ${MARKER} marker; not deleted`,
      );
    } else if (remove(join(root, path), path)) {
      removed.push(path);
    }
  }

  if (existsSync(join(runDir, 'sandbox')) && remove(join(runDir, 'sandbox'), 'sandbox')) {
    removed.push(join(runDir, 'sandbox'));
  }

  /** @type {string[]} */
  const artifacts = [];
  for (const path of TEMPLATE.artifacts ?? []) {
    const absolute = resolve(root, path);
    if (!isInside(absolute, root)) continue;
    const existedBefore = before.artifacts[path] === true;
    if (!existsSync(absolute)) continue;
    if (isLink(absolute) || !isInside(realpathSync(absolute), realpathSync(root))) {
      artifacts.push(`${path}: a link or outside the repository; not deleted`);
    } else if (existedBefore) {
      artifacts.push(`${path}: existed before the run, kept (gates may have refreshed it)`);
    } else if (opts['remove-artifacts'] === true) {
      if (remove(absolute, path)) artifacts.push(`${path}: created by the run, removed`);
    } else {
      artifacts.push(`${path}: created by the run, kept (pass --remove-artifacts to remove it)`);
    }
  }

  const after = snapshot(root);
  const differences = compareSnapshots(before, after);
  const result = {
    clean: differences.length === 0 && leftovers.length === 0 && failures.length === 0,
    finishedAt: new Date().toISOString(),
    removed,
    failures,
    artifacts,
    leftovers,
    differences,
    gitStatus: git(['status', '--short'], { cwd: root }).out.trim().split('\n').filter(Boolean)
      .length,
  };
  try {
    writeFileSync(join(runDir, 'clean.json'), JSON.stringify(result, null, 2));
  } catch (error) {
    // The verdict needs this record: without it the run is not clean, and the
    // reason is reported instead of a crash.
    result.clean = false;
    failures.push(`clean.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  print(result);
  if (!result.clean) process.exitCode = 1;
}

/**
 * The exit code a gate's log ends with (`DOBERMAN_EXIT=<code>`), or null when
 * the log is missing or the gate never finished (interrupted, killed by a
 * timeout before the marker was written).
 * @param {string} runDir
 * @param {string} gateId
 */
function loggedExit(runDir, gateId) {
  const path = join(runDir, 'logs', `${gateId.replace(/[^\w.-]/g, '-')}.log`);
  if (!existsSync(path)) return { path, exit: null };
  const codes = [...readFileSync(path, 'utf8').matchAll(EXIT_MARKER)];
  const last = codes.at(-1);
  return { path, exit: last === undefined ? null : Number(last[1]) };
}

/** @param {Options} opts */
function status(opts) {
  const runDir = runDirFrom(opts);
  const context = readContext(runDir);
  const gates = context.gates.map((gate) => {
    const { exit } = loggedExit(runDir, gate.id);
    return {
      id: gate.id,
      planned: gate.plan.run,
      log: exit === null ? 'no finished log' : `exit ${exit}`,
    };
  });
  /** @type {{ clean?: boolean } | null} */
  const cleaned = readJson(join(runDir, 'clean.json'));
  /** @type {{ valid?: boolean; verdict?: string | null } | null} */
  const decided = readJson(join(runDir, 'verdict.json'));
  const unfinished = gates.filter((gate) => gate.planned && gate.log === 'no finished log');
  let phase = 'incomplete';
  if (decided?.valid === true) phase = 'finished';
  else if (decided !== null) phase = 'verdict invalid';
  print({
    runDir,
    phase,
    verdict: decided?.valid === true ? decided.verdict : null,
    plannedGatesWithoutFinishedLog: unfinished.map((gate) => gate.id),
    result: existsSync(join(runDir, 'result.json')),
    cleaned: cleaned === null ? 'not run' : cleaned.clean === true ? 'clean' : 'not clean',
    gates,
  });
}

/**
 * @template T
 * @param {unknown} value
 * @returns {T[]}
 */
function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {Options} opts */
function verdict(opts) {
  const runDir = runDirFrom(opts);
  const context = readContext(runDir);
  /** @type {{ gates?: unknown; findings?: unknown; reproductions?: unknown; environmentLimitations?: unknown } | null} */
  const result = readJson(join(runDir, 'result.json'));
  if (result === null) fail(`${join(runDir, 'result.json')} is missing or not valid JSON.`);
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  if (context.detection.projectType === 'UNKNOWN') {
    errors.push('project type UNKNOWN: this doberman gives no verdict outside its template.');
  }
  for (const secret of secretsIn(readFileSync(join(runDir, 'result.json'), 'utf8'), context.root)) {
    errors.push(`result.json contains ${secret}: redact it (name the variable, never its value)`);
  }

  /** @type {ResultGate[]} */
  const gates = arrayOf(result.gates);
  /** @type {Finding[]} */
  const findings = arrayOf(result.findings);
  /** @type {Reproduction[]} */
  const reproductions = arrayOf(result.reproductions);

  /**
   * @param {string} kind
   * @param {(string | undefined)[]} ids
   */
  const duplicates = (kind, ids) => {
    const seen = new Set();
    for (const id of ids) {
      if (id !== undefined && seen.has(id)) errors.push(`${kind} ${id} appears more than once`);
      seen.add(id);
    }
  };
  duplicates(
    'gate',
    gates.map((gate) => gate.id),
  );
  duplicates(
    'finding',
    findings.map((finding) => finding.id),
  );
  duplicates(
    'reproduction',
    reproductions.map((item) => item.id),
  );

  const gateById = new Map(gates.map((gate) => [gate.id, gate]));
  for (const gate of gates) {
    const id = gate.id ?? '(gate without id)';
    const status = gate.status ?? 'missing';
    if (!isOneOf(GATE_STATUSES, gate.status)) {
      errors.push(`gate ${id}: status "${status}" is not one of ${GATE_STATUSES.join(', ')}`);
    }
    if (['PASS', 'FAIL'].includes(status) && !gate.evidence) {
      errors.push(`gate ${id}: ${status} without evidence (command, exit code, log)`);
    }
    if (['SKIPPED', 'NOT APPLICABLE', 'UNVERIFIED'].includes(status) && !gate.reason) {
      errors.push(`gate ${id}: ${status} without a reason`);
    }
    // A PASS or FAIL is what the gate's own log says, not what the report says.
    if ((status === 'PASS' || status === 'FAIL') && gate.id !== undefined) {
      const { path, exit } = loggedExit(runDir, gate.id);
      if (exit === null) {
        errors.push(
          `gate ${id}: ${status} but ${path} has no DOBERMAN_EXIT line: the gate did not finish (still running, timed out or interrupted); report it UNVERIFIED with the reason, or run it to the end`,
        );
      } else if (status === 'PASS' && exit !== 0) {
        errors.push(`gate ${id}: reported PASS but its log ends with exit ${exit}`);
      } else if (status === 'FAIL' && exit === 0) {
        errors.push(`gate ${id}: reported FAIL but its log ends with exit 0`);
      }
    }
  }

  /** @type {{ clean?: boolean; failures?: string[]; differences?: string[]; leftovers?: string[] } | null} */
  const cleaned = readJson(join(runDir, 'clean.json'));
  if (cleaned === null) {
    errors.push(
      'the cleanup has not run: `doberman.mjs clean --run <dir>` comes before the verdict',
    );
  }
  for (const planned of context.gates) {
    const reported = gateById.get(planned.id);
    if (reported === undefined) {
      errors.push(`gate ${planned.id} (${planned.name}) is in the plan but not in result.gates`);
    } else if (planned.plan.notApplicable && reported.status !== 'NOT APPLICABLE') {
      errors.push(
        `gate ${planned.id}: the plan says NOT APPLICABLE (${planned.plan.reason}), reported ${reported.status ?? 'nothing'}`,
      );
    } else if (!planned.plan.run && reported.status === 'PASS') {
      warnings.push(
        `gate ${planned.id} was not planned to run (${planned.plan.reason}) but is reported PASS: make sure it really ran`,
      );
    }
  }

  const reproductionById = new Map(reproductions.map((item) => [item.id, item]));
  for (const item of reproductions) {
    const id = item.id ?? '(reproduction without id)';
    if (!isOneOf(REPRO_STATUSES, item.status)) {
      errors.push(
        `reproduction ${id}: status "${item.status ?? 'missing'}" is not one of ${REPRO_STATUSES.join(', ')}`,
      );
    }
    if (!item.evidence) errors.push(`reproduction ${id}: no evidence (command and output)`);
  }

  for (const finding of findings) {
    const label = finding.id ?? finding.location ?? '(finding)';
    if (!isOneOf(SEVERITIES, finding.severity)) {
      errors.push(
        `finding ${label}: severity "${finding.severity ?? 'missing'}" is not one of ${SEVERITIES.join(', ')}`,
      );
    }
    if (!isOneOf(VERIFICATIONS, finding.verification)) {
      errors.push(
        `finding ${label}: verification "${finding.verification ?? 'missing'}" is not one of ${VERIFICATIONS.join(', ')}`,
      );
    }
    for (const field of FINDING_FIELDS) {
      const value = finding[field];
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`finding ${label}: "${field}" is empty`);
      }
    }
    if (finding.verification === 'REPRODUCED') {
      const reproduction = reproductionById.get(finding.reproductionId);
      if (reproduction?.status !== 'REPRODUCED') {
        errors.push(
          `finding ${label}: REPRODUCED needs reproductionId pointing at a REPRODUCED reproduction`,
        );
      }
    }
    if (finding.gate !== undefined && !gateById.has(finding.gate)) {
      errors.push(`finding ${label}: gate "${finding.gate}" is not in result.gates`);
    }
  }

  for (const gate of gates.filter((item) => item.status === 'FAIL')) {
    const explaining = findings.filter((finding) => finding.gate === gate.id);
    const planned = context.gates.find((item) => item.id === gate.id);
    const id = gate.id ?? '(gate without id)';
    if (explaining.length === 0) {
      errors.push(`gate ${id} FAILED and no finding explains it (set finding.gate = "${id}")`);
    } else if (
      planned?.required === true &&
      !explaining.some((finding) => finding.severity === 'BLOCKING')
    ) {
      errors.push(`gate ${id} is mandatory and FAILED: its finding must be BLOCKING`);
    }
  }

  const verified = findings.filter((finding) => finding.verification !== 'UNVERIFIED');
  /** @param {string} severity */
  const count = (severity) => verified.filter((finding) => finding.severity === severity).length;
  const counts = {
    BLOCKING: count('BLOCKING'),
    'SHOULD FIX': count('SHOULD FIX'),
    LOW: count('LOW'),
    NIT: count('NIT'),
    UNVERIFIED: findings.length - verified.length,
  };

  /** @type {string[]} */
  const limitations = [];
  for (const planned of context.gates.filter((gate) => gate.required)) {
    const reported = gateById.get(planned.id);
    if (reported?.status === 'SKIPPED' || reported?.status === 'UNVERIFIED') {
      limitations.push(`${planned.name}: ${reported.status} — ${reported.reason ?? ''}`);
    }
  }
  for (const planned of context.gates.filter(
    (gate) => !gate.required && gate.plan.blockedBy.length > 0,
  )) {
    limitations.push(`${planned.name}: SKIPPED — ${planned.plan.reason}`);
  }
  for (const limitation of arrayOf(result.environmentLimitations)) {
    if (typeof limitation === 'string' && !limitations.includes(limitation)) {
      limitations.push(limitation);
    }
  }
  // A workspace the run did not leave as it found it is never "ready".
  if (cleaned !== null && cleaned.clean !== true) {
    const details = [
      ...(cleaned.failures ?? []),
      ...(cleaned.leftovers ?? []),
      ...(cleaned.differences ?? []),
    ];
    limitations.push(`CLEANUP INCOMPLETE: ${details.join('; ') || 'see clean.json'}`);
  }

  let decision;
  if (counts.BLOCKING > 0) decision = 'DO NOT MERGE';
  else if (counts['SHOULD FIX'] > 0) decision = 'CHANGES REQUIRED';
  else if (limitations.length > 0) decision = 'READY WITH ENVIRONMENT LIMITATIONS';
  else decision = 'READY TO MERGE';

  const output = {
    valid: errors.length === 0,
    errors,
    warnings,
    verdict: errors.length === 0 ? decision : null,
    counts,
    environmentLimitations: limitations,
    note: 'No findings means this review and these gates found nothing; it does not prove the change is free of defects or vulnerabilities.',
    machineReadable: {
      projectType: context.detection.projectType.toLowerCase(),
      baseBranch: context.git.base?.ref ?? null,
      headBranch: context.git.branch,
      mergeBase: context.git.mergeBase,
      verdict: errors.length === 0 ? decision.replace(/ /g, '_') : null,
      gates,
      findings,
      reproductions,
      environmentLimitations: limitations,
    },
  };
  writeFileSync(join(runDir, 'verdict.json'), JSON.stringify(output, null, 2));
  print(output);
  if (errors.length > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------- main

const [command, ...rest] = process.argv.slice(2);
const RUN_ONLY = { values: ['run'], flags: [] };
switch (command) {
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(`${USAGE}\n`);
    break;
  case 'start':
    await start(parseOptions(rest, { values: ['base', 'mode'], flags: [] }));
    break;
  case 'sandbox':
    sandbox(parseOptions(rest, RUN_ONLY));
    break;
  case 'coverage':
    coverage(parseOptions(rest, RUN_ONLY));
    break;
  case 'clean':
    clean(parseOptions(rest, { values: ['run'], flags: ['remove-artifacts'] }));
    break;
  case 'verdict':
    verdict(parseOptions(rest, RUN_ONLY));
    break;
  case 'status':
    status(parseOptions(rest, RUN_ONLY));
    break;
  default:
    fail(`unknown command "${command}".\n${USAGE}`);
}

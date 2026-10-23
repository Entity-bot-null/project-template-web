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
//       DOBERMAN-TEMPORARY; a copy of each stays in <run>/reproductions) and
//       sandbox, optionally the gate artifacts that did not exist before the
//       run, then compares the workspace with the snapshot. Exits 1 when
//       something differs.
//   verdict --run <dir>
//       Validates <run>/result.json against the evidence rules (every PASS
//       and FAIL against its gate log, the cleanup done) and computes the
//       verdict. Exits 1 when the result is invalid.
//   status --run <dir>
//       Where a run is: gates finished or never finished, result written,
//       workspace cleaned, verdict computed. An interrupted run says so.
//   loop start [--base <ref>] [--mode default|full] [--max-rounds <1-5>]
//       An audit in rounds that fixes what each round finds (SKILL.md, --loop):
//       creates the loop directory, records the workspace as the loop found
//       it, pins the base and starts round 1 (a run directory inside it).
//   loop next --loop <dir>
//       Checks the last round's fixes (fixes.json against its findings and
//       the workspace) and starts the next round, which reviews them.
//   loop status --loop <dir>
//       The rounds so far, their verdicts, and what comes next.
//   loop finish --loop <dir> [--remove-artifacts]
//       Closes the loop: why it stopped, every round, what is still open and
//       the files the loop changed (summary.json).
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
 *   dir: string;
 *   round: number;
 *   maxRounds: number;
 *   previousRunDir: string | null;
 *   fixes: string[];
 *   patch: string | null;
 *   fixed: string[];
 *   deferred: Deferral[];
 * }} LoopContext
 * @typedef {{ finding: string; reason: string }} Deferral
 * @typedef {{
 *   round: number;
 *   runDir: string;
 *   startedAt: string;
 *   fixes?: { changed: string[]; fixed: string[]; deferred: Deferral[] };
 * }} LoopRound
 * @typedef {{
 *   version: number;
 *   loopDir: string;
 *   root: string;
 *   mode: string;
 *   maxRounds: number;
 *   base: Base | null;
 *   startedAt: string;
 *   rounds: LoopRound[];
 *   finished?: { at: string; reason: string };
 * }} LoopState
 * @typedef {{
 *   runDir: string;
 *   root: string;
 *   mode: string;
 *   detection: Detection;
 *   git: Omit<Scope, 'files'> & { files: FileChange[] };
 *   gates: (Gate & { plan: Plan })[];
 *   loop?: LoopContext | undefined;
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
/** The most rounds a loop runs: each one is a complete audit. */
const MAX_LOOP_ROUNDS = 5;
/** The modes a loop runs in: the others skip mandatory gates, which prove a fix. */
const LOOP_MODES = ['default', 'full'];
const READY_VERDICTS = ['READY TO MERGE', 'READY WITH ENVIRONMENT LIMITATIONS'];
/** A file the loop copies, to diff its fixes against: larger ones are listed, not copied. */
const MAX_COPIED_BYTES = 2 * 1024 * 1024;
/** The bytes of result.json a valid verdict checked, kept beside it. */
const VERIFIED_RESULT = 'result.verified.json';
const USAGE = `usage: node scripts/doberman.mjs <command> [options]

  start [--base <ref>] [--mode default|diff|full|security|tests]
  sandbox --run <dir>
  coverage --run <dir>
  clean --run <dir> [--remove-artifacts]
  verdict --run <dir>
  status --run <dir>
  loop start [--base <ref>] [--mode default|full] [--max-rounds <1-${MAX_LOOP_ROUNDS}>]
  loop next --loop <dir>
  loop status --loop <dir>
  loop finish --loop <dir> [--remove-artifacts]
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
 * @param {Base | null} [pinnedBase] a loop's base, resolved by its first round:
 *   every round compares against the same commit, wherever the ref moved since
 * @returns {Scope}
 */
function scope(root, opts, pinnedBase) {
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

  const base = pinnedBase === undefined ? chooseBase(opts.base, branch) : pinnedBase;
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
  return [...stateDifferences(before, after), ...entryDifferences(before, after)];
}

/**
 * What moved in the repository itself: HEAD, the branch, the index, the stash.
 * @param {Snapshot} before
 * @param {Snapshot} after
 */
function stateDifferences(before, after) {
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
  return differences;
}

/**
 * What changed in the files, one line each.
 * @param {Snapshot} before
 * @param {Snapshot} after
 */
function entryDifferences(before, after) {
  return changedPaths(before, after).map((path) => {
    const was = before.entries[path];
    const is = after.entries[path];
    if (was === undefined) return `new: ${path} (${is?.code.trim() ?? '?'})`;
    if (is === undefined) return `no longer changed or gone: ${path}`;
    return `modified: ${path}`;
  });
}

/**
 * The paths whose state differs between two snapshots: new, changed, or no
 * longer changed (put back as committed, or deleted).
 * @param {Snapshot} before
 * @param {Snapshot} after
 */
function changedPaths(before, after) {
  const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  return [...paths].sort().filter((path) => {
    const was = before.entries[path];
    const is = after.entries[path];
    return was === undefined || is === undefined || was.code !== is.code || was.hash !== is.hash;
  });
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

/** The repository's root, which every command runs from. */
function repositoryRoot() {
  const top = git(['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!top.ok) fail('not inside a git repository.');
  const root = resolve(top.out.trim());
  if (!samePath(process.cwd(), root)) fail(`run from the repository root: ${root}`);
  return root;
}

/** @param {Options} opts */
async function start(opts) {
  printContext(await createRun(opts));
}

/**
 * A new run: the workspace snapshot first, then detection, scope, gate plan
 * and environment probes, saved in a new private run directory. A loop's
 * round (`placement`) gets its directory inside the loop's, compares against
 * the loop's base, and records where it stands in the loop.
 * @param {Options} opts
 * @param {{ parent: string; name: string; pinnedBase?: Base | null; snapshot?: Snapshot; loop: LoopContext }} [placement]
 */
async function createRun(opts, placement) {
  const root = repositoryRoot();
  const mode = typeof opts.mode === 'string' ? opts.mode : 'default';
  if (!MODES.includes(mode)) fail(`--mode must be one of ${MODES.join(', ')}.`);

  const before = placement?.snapshot ?? snapshot(root);
  /** @type {string | undefined} */
  let runDir;
  if (placement !== undefined) {
    // A round's directory is made inside its loop's private one, never
    // twice, with its copy of the files changed when it started taken at
    // once: the state the snapshot describes, which the next round's patch
    // of this round's fixes is diffed against.
    runDir = join(placement.parent, placement.name);
    try {
      mkdirSync(runDir, { mode: 0o700 });
    } catch {
      fail(`${runDir} exists already: a round is never started twice.`);
    }
    copyChangedFiles(root, before, join(runDir, 'workspace'));
  }
  const detection = detect(root);
  const operation = inProgressOperation(root);
  const prScope = scope(root, opts, placement?.pinnedBase);
  const effectiveMode = prScope.unborn && mode === 'default' ? 'full' : mode;
  const probes = await probeEnvironment(root);
  const gates =
    detection.projectType === 'UNKNOWN'
      ? []
      : discoverGates(root, prScope.files, effectiveMode, probes, prScope.unborn);

  // A new private directory every time (mkdtemp: created by this call, mode
  // 0700): never one that already exists or someone else prepared.
  if (runDir === undefined) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    runDir = mkdtempSync(join(privateRunsRoot(), `${basename(root)}-${stamp}-`));
  }
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
    ...(placement === undefined ? {} : { loop: placement.loop }),
  };
  writeFileSync(join(runDir, 'snapshot.json'), JSON.stringify(before, null, 2));
  writeFileSync(join(runDir, 'context.json'), JSON.stringify(context, null, 2));
  return context;
}

/**
 * Prints a run's context. The full file list stays in context.json: large
 * changes would flood the output.
 * @param {{ git: { files: FileChange[] } }} context
 */
function printContext(context) {
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
  const diff = git(
    [
      'diff',
      '-U0',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--text',
      diffBase,
      '--',
      file.path,
    ],
    { cwd: root },
  ).out;
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
  /** @type {string[]} */
  const warnings = [];

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
    } else {
      // A copy stays in the run directory: a fix (--fix, --loop) turns the
      // reproduction into its permanent regression test. A copy that fails
      // is said, and the cleanup goes on.
      const copy = join(runDir, 'reproductions', path);
      try {
        if (isInside(copy, join(runDir, 'reproductions'))) {
          mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
          writeFileSync(copy, readFileSync(join(root, path)));
        }
      } catch (error) {
        warnings.push(
          `${path}: no copy kept in the run directory (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (remove(join(root, path), path)) removed.push(path);
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
    warnings,
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
  // A round the loop has moved past is closed: its verdict, and the findings
  // the next round was checked against, stay as they were.
  if (context.loop !== undefined) {
    /** @type {LoopState | null} */
    const state = readJson(join(context.loop.dir, 'loop.json'));
    const latest = Math.max(0, ...arrayOf(state?.rounds).map((item) => Number(item?.round)));
    if (state?.finished !== undefined || latest > context.loop.round) {
      fail(
        `round ${context.loop.round} of this loop is closed (${state?.finished ? 'the loop is finished' : `the loop is at round ${latest}`}): its verdict stands as it was.`,
      );
    }
  }
  // Read once: what is checked, scanned for secrets and digested is the same.
  /** @type {Buffer | null} */
  let raw = null;
  /** @type {{ gates?: unknown; findings?: unknown; reproductions?: unknown; environmentLimitations?: unknown } | null} */
  let result = null;
  try {
    raw = readFileSync(join(runDir, 'result.json'));
    result = JSON.parse(raw.toString('utf8'));
  } catch {
    // Missing or not JSON: refused just below.
  }
  if (raw === null || result === null || typeof result !== 'object') {
    fail(`${join(runDir, 'result.json')} is missing or not valid JSON.`);
  }
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  if (context.detection.projectType === 'UNKNOWN') {
    errors.push('project type UNKNOWN: this doberman gives no verdict outside its template.');
  }
  for (const secret of secretsIn(raw.toString('utf8'), context.root)) {
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
    if (typeof finding.id !== 'string' || finding.id.trim() === '') {
      errors.push(`finding ${label}: "id" is missing (a unique id such as F1)`);
    }
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

  // A later round of a loop reports what the round before it left unfixed;
  // a verdict given again keeps what the earlier one found.
  if (context.loop !== undefined) {
    /** @type {{ carriedFrom?: unknown; evidence?: unknown }[]} */
    const resolved = arrayOf(/** @type {{ resolved?: unknown }} */ (result).resolved);
    errors.push(...carryErrors(context.loop, findings, resolved));
    /** @type {{ id?: unknown; evidence?: unknown }[]} */
    const withdrawn = arrayOf(/** @type {{ withdrawn?: unknown }} */ (result).withdrawn);
    errors.push(...withdrawalErrors(verifiedResult(runDir), findings, withdrawn));
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
    // What was validated: a loop refuses a result.json changed after its verdict.
    resultSha256: sha256(raw),
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
  // What a valid verdict checked, byte for byte: a loop reads this copy only.
  if (errors.length === 0) writeFileSync(join(runDir, VERIFIED_RESULT), raw);
  print(output);
  if (errors.length > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------- loop

/**
 * `--max-rounds`: a whole number from 1 to MAX_LOOP_ROUNDS; that limit when
 * not given.
 * @param {string | boolean | undefined} value
 */
function maxRoundsFrom(value) {
  if (value === undefined) return MAX_LOOP_ROUNDS;
  const rounds = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(rounds >= 1 && rounds <= MAX_LOOP_ROUNDS)) {
    fail(`--max-rounds must be a whole number from 1 to ${MAX_LOOP_ROUNDS}.`);
  }
  return rounds;
}

/** @param {Options} opts */
function loopDirFrom(opts) {
  const dir = opts.loop;
  if (typeof dir !== 'string')
    fail('--loop <dir> is required (printed by `loop start` as loop.dir).');
  const absolute = resolve(dir);
  if (!isInside(absolute, runsRoot()) || !existsSync(join(absolute, 'loop.json'))) {
    fail(`${dir} is not a doberman loop directory.`);
  }
  return absolute;
}

/**
 * The loop's state.
 * @param {string} loopDir
 */
function readLoop(loopDir) {
  /** @type {LoopState | null} */
  const state = readJson(join(loopDir, 'loop.json'));
  if (state === null || !Array.isArray(state.rounds) || state.rounds.length === 0) {
    fail(`${join(loopDir, 'loop.json')} is missing or not a loop's state.`);
  }
  return state;
}

/**
 * The loop's state, for a command that acts on the repository: from the
 * repository the loop belongs to only, at its root.
 * @param {string} loopDir
 * @returns {{ state: LoopState; root: string }}
 */
function openLoop(loopDir) {
  const state = readLoop(loopDir);
  const root = repositoryRoot();
  if (!samePath(root, state.root)) {
    fail(`this loop belongs to ${state.root}: run the command from that repository's root.`);
  }
  return { state, root };
}

/** @param {LoopState} state */
function saveLoop(state) {
  writeFileSync(join(state.loopDir, 'loop.json'), JSON.stringify(state, null, 2));
}

/**
 * A round's verdict output, when it is valid and its result.json is still
 * the one it validated.
 * @param {Pick<LoopRound, 'round' | 'runDir'>} round
 * @returns {{ verdict: string; counts: Record<string, number>; environmentLimitations: string[] } | null}
 */
function roundVerdict(round) {
  /** @type {{ valid?: boolean; verdict?: string; counts?: Record<string, number>; environmentLimitations?: string[]; resultSha256?: string } | null} */
  const decided = readJson(join(round.runDir, 'verdict.json'));
  if (decided?.valid !== true || typeof decided.verdict !== 'string') return null;
  if (decided.resultSha256 !== verifiedDigest(round.runDir)) return null;
  return {
    verdict: decided.verdict,
    counts: decided.counts ?? {},
    environmentLimitations: decided.environmentLimitations ?? [],
  };
}

/**
 * The digest of the result a run's valid verdict checked (result.verified.json,
 * the very bytes), or null without one.
 * @param {string} runDir
 */
function verifiedDigest(runDir) {
  const path = join(runDir, VERIFIED_RESULT);
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

/**
 * The result a run's valid verdict checked: what a loop builds on, whatever
 * happened to result.json since.
 * @param {string} runDir
 * @returns {{ findings?: unknown; resolved?: unknown; withdrawn?: unknown } | null}
 */
function verifiedResult(runDir) {
  return readJson(join(runDir, VERIFIED_RESULT));
}

/**
 * Why a round has no verdict the loop can build on, or null when it has one.
 * @param {Pick<LoopRound, 'round' | 'runDir'>} round
 */
function verdictProblem(round) {
  if (roundVerdict(round) !== null) return null;
  /** @type {{ valid?: boolean } | null} */
  const decided = readJson(join(round.runDir, 'verdict.json'));
  if (decided?.valid === true) {
    return `round ${round.round}'s ${VERIFIED_RESULT}, the engine's record of what its verdict checked, is missing or changed: it cannot be rebuilt by hand; while the round is the current one, run \`verdict --run ${round.runDir}\` again`;
  }
  return `round ${round.round} has no valid verdict: finish it (its gates, \`clean\`, result.json, \`verdict\`) first`;
}

/**
 * A path as git prints it, from one written in fixes.json.
 * @param {string} path
 */
function repoPath(path) {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

/**
 * The untracked files named like a reproduction, marked or not, but those
 * that were there before the loop (`baseline`): not its own, and kept, as
 * `clean` keeps them.
 * @param {string} root
 * @param {Snapshot} baseline
 */
function temporaryFiles(root, baseline) {
  return gitList(['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root }).filter(
    (path) => basename(path).includes('.doberman.') && baseline.entries[path] === undefined,
  );
}

/** A test file, by the names the templates give them (*.spec.*, *.test.*). */
const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

/**
 * Copies the files a snapshot lists as changed (regular files up to
 * MAX_COPIED_BYTES, read without following a link) to `dest`, under their
 * paths: the state a round started from, which the next round's patch is
 * diffed against.
 * @param {string} root
 * @param {Snapshot} from
 * @param {string} dest
 */
function copyChangedFiles(root, from, dest) {
  for (const path of Object.keys(from.entries)) {
    const target = join(dest, path);
    if (!isInside(target, dest)) continue;
    let fd;
    try {
      fd = openSync(join(root, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      continue; // deleted, or a link
    }
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile() || stats.size > MAX_COPIED_BYTES) continue;
      // Only the state the snapshot describes: a file changed since it was
      // taken gets no copy, and the next patch says it was not diffed.
      const bytes = readFileSync(fd);
      if (sha256(bytes) !== from.entries[path]?.hash) continue;
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes);
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * The patch of a round's fixes (<run>/fixes.patch): each file changed since
 * the round started, from its state then (the round's copy, or HEAD's when it
 * was unchanged) to now. Binary and large files are named, not diffed. Only
 * plain files are compared (`git diff --no-index`): nothing in the repository
 * changes.
 * @param {string} root
 * @param {LoopRound} round
 * @param {Snapshot} before the round's snapshot
 * @param {string[]} changed
 */
function writeFixesPatch(root, round, before, changed) {
  const sides = join(round.runDir, 'patch-sides');
  rmSync(sides, { recursive: true, force: true });
  mkdirSync(sides, { mode: 0o700 });
  const empty = join(sides, 'empty');
  writeFileSync(empty, '');
  /** @type {string[]} */
  const parts = [];
  changed.forEach((path, index) => {
    const was = before.entries[path];
    let old = empty;
    if (was !== undefined) {
      const copy = join(round.runDir, 'workspace', path);
      if (existsSync(copy)) old = copy;
      else if (was.hash !== 'missing') {
        parts.push(
          `# ${path}: changed; not diffed (larger than 2 MB, not a regular file, or changed while the round started)\n`,
        );
        return;
      }
    } else {
      // Unchanged when the round started: as HEAD has it, or new since.
      const shown = spawnSync('git', ['show', `HEAD:${path}`], {
        cwd: root,
        maxBuffer: 256 * 1024 * 1024,
      });
      if (shown.status === 0) {
        old = join(sides, `${String(index)}.old`);
        writeFileSync(old, shown.stdout);
      }
    }
    const current = join(root, path);
    const now = isLink(current) || !existsSync(current) ? empty : current;
    if ((old !== empty && isBinary(old)) || (now !== empty && isBinary(now))) {
      parts.push(`# ${path}: binary file changed\n`);
      return;
    }
    // git's own diff, as text: never an external diff tool, a textconv filter
    // or a `-diff` attribute that would hide the change (real binaries were
    // named above).
    const diff = git(
      [
        'diff',
        '--no-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--text',
        '--',
        old,
        now,
      ],
      { allowFailure: true },
    );
    // 0: the same, 1: different; anything else is git failing to compare them.
    if (diff.status !== 0 && diff.status !== 1) {
      parts.push(`# ${path}: could not be diffed (${diff.err.trim() || 'git diff failed'})\n`);
      return;
    }
    const hunks = diff.out.slice(Math.max(diff.out.indexOf('\n@@'), 0)).replace(/^\n/, '');
    if (!hunks.startsWith('@@')) {
      parts.push(
        diff.status === 0
          ? `# ${path}: no change in its content\n`
          : `# ${path}: changed; its content could not be shown\n`,
      );
      return;
    }
    const from = old === empty ? '/dev/null' : `a/${path}`;
    const to = now === empty ? '/dev/null' : `b/${path}`;
    parts.push(`--- ${from}\n+++ ${to}\n${hunks}`);
  });
  rmSync(sides, { recursive: true, force: true });
  const patch = join(round.runDir, 'fixes.patch');
  writeFileSync(patch, parts.join(''));
  return patch;
}

/**
 * What a round's fixes.json says, against the round's findings and the files
 * changed since the round started: every verified BLOCKING and SHOULD FIX
 * fixed or deferred with its reason, each once; a fix's files among the
 * changed ones; a reproduced bug's reproduction kept as a permanent test this
 * round added or changed.
 * @param {string} root
 * @param {LoopRound} round
 * @param {Snapshot} before the round's snapshot
 * @param {Snapshot} now
 */
function checkFixes(root, round, before, now) {
  const changed = changedPaths(before, now);
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const fixed = [];
  /** @type {Deferral[]} */
  const deferred = [];
  /** @type {Finding[]} */
  const findings = arrayOf(verifiedResult(round.runDir)?.findings);
  /** @type {{ fixed?: unknown; deferred?: unknown } | null} */
  const fixes = readJson(join(round.runDir, 'fixes.json'));
  if (fixes === null) {
    errors.push(
      `${join(round.runDir, 'fixes.json')} is missing or not valid JSON: write what round ${round.round} fixed and what it deferred (reference/report.md#fixesjson)`,
    );
    return { errors, fixed, deferred, changed };
  }
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  /** @type {Set<unknown>} */
  const listed = new Set();
  /**
   * @param {unknown} id
   * @param {string} list
   */
  const account = (id, list) => {
    if (typeof id !== 'string' || !byId.has(id)) {
      errors.push(`fixes.json ${list}: "${String(id)}" is not a finding of round ${round.round}`);
      return undefined;
    }
    if (listed.has(id)) errors.push(`fixes.json lists ${id} more than once`);
    listed.add(id);
    return id;
  };
  /** @type {{ finding?: unknown; files?: unknown; regressionTest?: unknown }[]} */
  const fixEntries = arrayOf(fixes.fixed);
  for (const entry of fixEntries) {
    const id = account(entry?.finding, 'fixed');
    if (id === undefined) continue;
    if (byId.get(id)?.verification === 'UNVERIFIED') {
      errors.push(`fixed ${id}: an UNVERIFIED finding is carried, never fixed`);
    }
    /** @type {unknown[]} */
    const named = arrayOf(entry.files);
    const files = named.filter((file) => typeof file === 'string').map(repoPath);
    if (files.length === 0) errors.push(`fixed ${id}: "files" names no file`);
    for (const file of files) {
      // A file; or a directory new since the round started, written as
      // `git status --short` prints it (src/x/): everything in it is new.
      const inside = file.endsWith('/') ? changed.filter((path) => path.startsWith(file)) : [];
      const newFolder =
        inside.length > 0 &&
        inside.every(
          (path) => now.entries[path]?.code === '??' && before.entries[path] === undefined,
        );
      if (!changed.includes(file) && !newFolder) {
        errors.push(`fixed ${id}: ${file} has not changed since round ${round.round} started`);
      }
    }
    if (byId.get(id)?.verification === 'REPRODUCED') {
      const test = typeof entry.regressionTest === 'string' ? repoPath(entry.regressionTest) : '';
      if (test === '') {
        errors.push(
          `fixed ${id}: a reproduced bug keeps its reproduction as a regression test ("regressionTest")`,
        );
      } else if (
        !TEST_FILE.test(test) ||
        basename(test).includes('.doberman.') ||
        !changed.includes(test) ||
        !existsSync(join(root, test)) ||
        isMarkedTemporary(join(root, test))
      ) {
        errors.push(
          `fixed ${id}: regressionTest ${test} must be a test file (*.spec.* or *.test.*) this round added or changed, kept for good (no .doberman. name, no ${MARKER} marker)`,
        );
      }
    }
    fixed.push(id);
  }
  /** @type {{ finding?: unknown; reason?: unknown }[]} */
  const deferEntries = arrayOf(fixes.deferred);
  for (const entry of deferEntries) {
    const id = account(entry?.finding, 'deferred');
    if (id === undefined) continue;
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      errors.push(`deferred ${id}: no reason (the decision it needs)`);
    } else {
      deferred.push({ finding: id, reason: entry.reason.trim() });
    }
  }
  for (const finding of findings) {
    if (finding.verification === 'UNVERIFIED') continue;
    if (finding.severity !== 'BLOCKING' && finding.severity !== 'SHOULD FIX') continue;
    if (!listed.has(finding.id)) {
      errors.push(
        `${finding.severity} ${String(finding.id)} is neither fixed nor deferred in fixes.json`,
      );
    }
  }
  return { errors, fixed, deferred, changed };
}

/**
 * What the loop never does, found in the workspace: a commit, a staged change,
 * a branch switch or a stash since `since`; a reproduction file of its own
 * left behind (one that was there before the loop, in `baseline`, is not).
 * @param {string} root
 * @param {Snapshot} baseline the workspace as the loop found it
 * @param {Snapshot} since
 * @param {Snapshot} now
 * @param {string} label when `since` was taken
 */
function loopViolations(root, baseline, since, now, label) {
  return [
    ...stateDifferences(since, now).map(
      (difference) =>
        `${difference} since ${label}: the loop never commits, stages, switches branches or stashes; put it back as it was`,
    ),
    ...temporaryFiles(root, baseline).map(
      (path) =>
        `${path}: a reproduction file is still there (\`clean\` deletes the run's own; a fix keeps its regression test as a permanent one)`,
    ),
  ];
}

/**
 * A verdict given again to a round of a loop keeps every finding the earlier
 * verdict checked (its fields and severity may change): a fixed one stays in
 * result.json and goes in fixes.json; one that proved false is withdrawn,
 * with the evidence, and stays withdrawn in later verdicts of the round.
 * @param {{ findings?: unknown; withdrawn?: unknown } | null} earlier the result the round's last valid verdict checked
 * @param {Finding[]} findings
 * @param {{ id?: unknown; evidence?: unknown }[]} withdrawn
 */
function withdrawalErrors(earlier, findings, withdrawn) {
  /** @type {string[]} */
  const errors = [];
  if (earlier === null) {
    // A round's first verdict has nothing to withdraw.
    for (const entry of withdrawn) {
      errors.push(
        `withdrawn "${String(entry?.id)}": not a finding this round's earlier verdict checked (it has none yet)`,
      );
    }
    return errors;
  }
  /** @type {Finding[]} */
  const before = arrayOf(earlier.findings);
  /** @type {{ id?: unknown }[]} */
  const withdrawnBefore = arrayOf(earlier.withdrawn);
  /** @type {Set<unknown>} */
  const reported = new Set(findings.map((finding) => finding.id));
  /** @type {Map<unknown, { id?: unknown; evidence?: unknown }>} */
  const listed = new Map(withdrawn.map((entry) => [entry?.id, entry]));
  /** @type {Set<unknown>} */
  const owed = new Set([
    ...before.map((finding) => finding.id).filter((id) => !reported.has(id)),
    ...withdrawnBefore.map((entry) => entry?.id).filter((id) => !reported.has(id)),
  ]);
  for (const id of owed) {
    const entry = listed.get(id);
    if (entry === undefined) {
      errors.push(
        `finding ${String(id)} of this round's earlier verdict is gone: a fixed finding stays in result.json (and goes in fixes.json); one that proved false goes in "withdrawn", with the evidence`,
      );
    } else if (typeof entry.evidence !== 'string' || entry.evidence.trim() === '') {
      errors.push(`withdrawn ${String(id)}: no evidence that it was not real`);
    }
  }
  for (const id of listed.keys()) {
    if (!owed.has(id)) {
      errors.push(
        `withdrawn "${String(id)}": not a finding this round's earlier verdict checked and this one leaves out`,
      );
    }
  }
  return errors;
}

/**
 * A round after the first reports everything the previous round left
 * unfixed: each such finding carried (a finding with carriedFrom
 * "<round>:<id>", checked again against the current code), or listed in
 * `resolved` with the evidence that it no longer applies. Nothing found
 * earlier drops out of the loop's last report.
 * @param {LoopContext} loop
 * @param {Finding[]} findings
 * @param {{ carriedFrom?: unknown; evidence?: unknown }[]} resolved
 */
function carryErrors(loop, findings, resolved) {
  /** @type {string[]} */
  const errors = [];
  if (loop.previousRunDir === null) return errors;
  const round = loop.round - 1;
  // The findings the previous round's verdict checked, and nothing else.
  const problem = verdictProblem({ round, runDir: loop.previousRunDir });
  if (problem !== null) errors.push(problem);
  const previous = verifiedResult(loop.previousRunDir);
  /** @type {Finding[]} */
  const earlier = arrayOf(previous?.findings);
  const fixed = new Set(loop.fixed);
  const open = new Map(
    earlier
      .filter((finding) => typeof finding.id === 'string' && !fixed.has(finding.id))
      .map((finding) => [`${round}:${String(finding.id)}`, finding]),
  );
  /** @type {Set<string>} */
  const claimed = new Set();
  /**
   * @param {unknown} key
   * @param {string} label
   */
  const claim = (key, label) => {
    if (typeof key !== 'string' || !open.has(key)) {
      const prefix = `${String(round)}:`;
      const wasFixed =
        typeof key === 'string' && key.startsWith(prefix) && fixed.has(key.slice(prefix.length));
      errors.push(
        wasFixed
          ? `${label}: ${key} was fixed by round ${round}; a fix that did not hold is a new finding with "reopens": "${key}"`
          : `${label}: "${String(key)}" is not a finding round ${round} left unfixed (write "<round>:<id>")`,
      );
      return;
    }
    if (claimed.has(key)) errors.push(`${key} is carried or resolved more than once`);
    claimed.add(key);
  };
  for (const finding of findings) {
    if (finding.carriedFrom !== undefined) {
      claim(finding.carriedFrom, `finding ${String(finding.id ?? '?')} carriedFrom`);
    }
    // A fix that did not hold: a finding of this round, naming the fixed one.
    if (finding.reopens !== undefined) {
      const fixedKey = typeof finding.reopens === 'string' && /^(\d+):(.+)$/.exec(finding.reopens);
      if (!fixedKey || Number(fixedKey[1]) !== round || !fixed.has(fixedKey[2] ?? '')) {
        errors.push(
          `finding ${String(finding.id ?? '?')} reopens "${String(finding.reopens)}": not a finding round ${round} fixed (write "<round>:<id>")`,
        );
      }
    }
  }
  for (const entry of resolved) {
    claim(entry?.carriedFrom, 'resolved');
    if (typeof entry?.evidence !== 'string' || entry.evidence.trim() === '') {
      errors.push(`resolved ${String(entry?.carriedFrom)}: no evidence that it no longer applies`);
    }
  }
  for (const [key, finding] of open) {
    if (claimed.has(key)) continue;
    const title = typeof finding.title === 'string' ? finding.title : (finding.location ?? '');
    errors.push(
      `${key} (${String(finding.severity ?? '?')}: ${title}) was left unfixed by round ${round}: carry it (a finding with carriedFrom "${key}") or list it in resolved with the evidence that it no longer applies`,
    );
  }
  return errors;
}

/**
 * Why a finding the last round reports is still open, when an earlier round
 * deferred it: followed back through carriedFrom.
 * @param {LoopState} state
 * @param {Finding} finding
 */
function deferralOf(state, finding) {
  let current = finding;
  // Each hop goes one round back: never more hops than rounds.
  let hops = 0;
  while (hops < state.rounds.length) {
    hops += 1;
    const match =
      typeof current.carriedFrom === 'string' && /^(\d+):(.+)$/.exec(current.carriedFrom);
    if (!match) return null;
    const round = state.rounds.find((item) => item.round === Number(match[1]));
    if (round === undefined) return null;
    const id = match[2];
    const deferral = round.fixes?.deferred.find((item) => item.finding === id);
    if (deferral !== undefined) return deferral.reason;
    /** @type {Finding[]} */
    const findings = arrayOf(verifiedResult(round.runDir)?.findings);
    const earlier = findings.find((item) => item.id === id);
    if (earlier === undefined) return null;
    current = earlier;
  }
  return null;
}

/** @param {Options} opts */
async function loopStart(opts) {
  const mode = typeof opts.mode === 'string' ? opts.mode : 'default';
  if (!LOOP_MODES.includes(mode)) {
    fail(
      `a loop runs in --mode ${LOOP_MODES.join(' or ')}: diff, security and tests skip mandatory gates, so no round could prove its fixes.`,
    );
  }
  const maxRounds = maxRoundsFrom(opts['max-rounds']);
  const root = repositoryRoot();
  if (opts.base === true) fail('--base needs a ref: --base <branch or commit>.');
  if (typeof opts.base === 'string' && resolveRef(opts.base) === null) {
    fail(`--base ${opts.base} is not a commit in this repository.`);
  }
  const baseline = snapshot(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const loopDir = mkdtempSync(join(privateRunsRoot(), `${basename(root)}-${stamp}-loop-`));
  writeFileSync(join(loopDir, 'snapshot.json'), JSON.stringify(baseline, null, 2));
  const context = await createRun(
    { ...(typeof opts.base === 'string' ? { base: opts.base } : {}), mode },
    {
      parent: loopDir,
      name: 'round-1',
      loop: {
        dir: loopDir,
        round: 1,
        maxRounds,
        previousRunDir: null,
        fixes: [],
        patch: null,
        fixed: [],
        deferred: [],
      },
    },
  );
  // A round that cannot start makes no loop: nothing would ever close it.
  if (context.blockers.length > 0) {
    rmSync(loopDir, { recursive: true, force: true });
    fail(`no loop started: ${context.blockers.join('; ')}.`);
  }
  /** @type {LoopState} */
  const state = {
    version: 1,
    loopDir,
    root,
    mode: context.mode,
    maxRounds,
    base: context.git.base,
    startedAt: baseline.takenAt,
    rounds: [{ round: 1, runDir: context.runDir, startedAt: new Date().toISOString() }],
  };
  saveLoop(state);
  printContext(context);
}

/** @param {Options} opts */
async function loopNext(opts) {
  const loopDir = loopDirFrom(opts);
  const { state, root } = openLoop(loopDir);
  if (state.finished) {
    fail(`this loop is finished (${state.finished.reason}): see ${join(loopDir, 'summary.json')}.`);
  }
  const last = /** @type {LoopRound} */ (state.rounds.at(-1));
  const problem = verdictProblem(last);
  if (problem !== null) fail(`${problem}, before the next round.`);
  if (state.rounds.length >= state.maxRounds) {
    fail(
      `the loop has run its ${state.maxRounds} round(s): \`loop finish --loop ${loopDir}\` closes it (a fix made now would go unreviewed).`,
    );
  }
  /** @type {Snapshot} */
  const baseline = readJson(join(loopDir, 'snapshot.json'));
  /** @type {Snapshot} */
  const before = readJson(join(last.runDir, 'snapshot.json'));
  const now = snapshot(root);
  const check = checkFixes(root, last, before, now);
  const { changed } = check;
  const errors = [
    ...loopViolations(root, baseline, before, now, `round ${last.round} started`),
    ...check.errors,
  ];
  if (errors.length === 0 && check.fixed.length === 0) {
    errors.push(
      `round ${last.round} fixed nothing (fixes.json): the next round reviews the previous round's fixes, so it would have nothing to review; \`loop finish\` closes the loop`,
    );
  }
  if (errors.length > 0) {
    print({ valid: false, round: last.round, errors });
    process.exitCode = 1;
    return;
  }
  const round = last.round + 1;
  const name = `round-${String(round)}`;
  // A round directory loop.json does not list never started: one cut off
  // while it was being created. It is the loop's own, and made again.
  rmSync(join(loopDir, name), { recursive: true, force: true });
  const patch = writeFixesPatch(root, last, before, changed);
  const context = await createRun(
    { mode: state.mode },
    {
      parent: loopDir,
      name,
      pinnedBase: state.base,
      // The state the fixes were checked against is the new round's start.
      snapshot: now,
      loop: {
        dir: loopDir,
        round,
        maxRounds: state.maxRounds,
        previousRunDir: last.runDir,
        fixes: changed,
        patch,
        fixed: check.fixed,
        deferred: check.deferred,
      },
    },
  );
  if (context.blockers.length > 0) {
    rmSync(context.runDir, { recursive: true, force: true });
    fail(
      `round ${round} cannot start: ${context.blockers.join('; ')}. The loop stays at round ${last.round}; run \`loop next\` again once that is resolved.`,
    );
  }
  last.fixes = { changed, fixed: check.fixed, deferred: check.deferred };
  state.rounds.push({ round, runDir: context.runDir, startedAt: new Date().toISOString() });
  saveLoop(state);
  printContext(context);
}

/** @param {Options} opts */
function loopStatus(opts) {
  const loopDir = loopDirFrom(opts);
  const state = readLoop(loopDir);
  const rounds = state.rounds.map((round) => {
    const decided = roundVerdict(round);
    let phase = 'in progress';
    if (decided !== null) phase = 'decided';
    else if (existsSync(join(round.runDir, 'verdict.json'))) phase = 'verdict invalid';
    else if (existsSync(join(round.runDir, 'result.json'))) phase = 'result written';
    return {
      round: round.round,
      runDir: round.runDir,
      phase,
      verdict: decided?.verdict ?? null,
      counts: decided?.counts ?? null,
      fixesWritten: existsSync(join(round.runDir, 'fixes.json')),
    };
  });
  const last = /** @type {(typeof rounds)[number]} */ (rounds.at(-1));
  let next;
  if (state.finished) {
    next = `finished (${state.finished.reason}): ${join(loopDir, 'summary.json')}`;
  } else if (last.verdict === null) {
    next = `finish round ${last.round}: its gates, \`clean --run ${last.runDir} --remove-artifacts\`, result.json, then \`verdict --run ${last.runDir}\` (\`status --run\` names the gates without a finished log)`;
  } else if (state.rounds.length >= state.maxRounds) {
    next = `\`loop finish --loop ${loopDir} --remove-artifacts\`: the loop has run its ${state.maxRounds} round(s)`;
  } else if (READY_VERDICTS.includes(last.verdict)) {
    next = `round ${last.round} ended ${last.verdict}: fix the LOW and NIT findings within the loop's reach, write fixes.json and run \`loop next\`; with none, \`loop finish\``;
  } else {
    next = `fix round ${last.round}'s findings, write fixes.json, then \`loop next\`; \`loop finish\` only when every BLOCKING and SHOULD FIX left needs the user's decision (all deferred in fixes.json, nothing fixed)`;
  }
  print({
    loopDir,
    mode: state.mode,
    base: state.base,
    maxRounds: state.maxRounds,
    roundsRun: state.rounds.length,
    finished: state.finished ?? null,
    rounds,
    next,
  });
}

/** @param {Options} opts */
function loopFinish(opts) {
  const loopDir = loopDirFrom(opts);
  const { state, root } = openLoop(loopDir);
  if (state.finished) {
    fail(
      `this loop is finished already (${state.finished.reason}): see ${join(loopDir, 'summary.json')}.`,
    );
  }
  const last = /** @type {LoopRound} */ (state.rounds.at(-1));
  const decided = roundVerdict(last);
  if (decided === null) {
    fail(`${String(verdictProblem(last))}, before closing the loop.`);
  }
  /** @type {Snapshot} */
  const baseline = readJson(join(loopDir, 'snapshot.json'));
  /** @type {Snapshot} */
  const lastStart = readJson(join(last.runDir, 'snapshot.json'));
  const now = snapshot(root);
  const unreviewed = changedPaths(lastStart, now);
  const roundsLeft = state.rounds.length < state.maxRounds;
  const errors = loopViolations(root, baseline, lastStart, now, `round ${last.round} started`);
  // Every earlier round as its verdict checked it: the summary reads them all.
  for (const round of state.rounds.slice(0, -1)) {
    const problem = verdictProblem(round);
    if (problem !== null) errors.push(problem);
  }
  if (unreviewed.length > 0) {
    errors.push(
      `changed after round ${last.round} started, so never reviewed: ${unreviewed.join(', ')}. ${roundsLeft ? 'Write fixes.json and run `loop next`: the next round reviews them' : 'The loop has no round left: undo them'} (a fix stays only once a round has reviewed it).`,
    );
  }
  let reason;
  if (READY_VERDICTS.includes(decided.verdict)) {
    reason = 'ready';
  } else if (!roundsLeft) {
    reason = 'round-limit';
  } else {
    // Stopping with rounds left and a BLOCKING or SHOULD FIX open: only when
    // each one needs the user's decision, deferred in fixes.json.
    reason = 'needs-decision';
    const check = checkFixes(root, last, lastStart, now);
    errors.push(...check.errors);
    if (check.fixed.length > 0) {
      errors.push(
        `fixes.json of round ${last.round} lists fixes: \`loop next\` reviews them in another round`,
      );
    }
    last.fixes = { changed: [], fixed: [], deferred: check.deferred };
  }
  if (errors.length > 0) {
    print({ valid: false, round: last.round, errors });
    process.exitCode = 1;
    return;
  }

  /** @type {string[]} */
  const artifacts = [];
  for (const path of TEMPLATE.artifacts ?? []) {
    const absolute = resolve(root, path);
    if (!isInside(absolute, root) || !existsSync(absolute)) continue;
    if (baseline.artifacts[path] === true) continue;
    if (isLink(absolute) || !isInside(realpathSync(absolute), realpathSync(root))) {
      artifacts.push(`${path}: a link or outside the repository; not deleted`);
    } else if (opts['remove-artifacts'] === true) {
      try {
        rmSync(absolute, { recursive: true, force: true, maxRetries: 3 });
        artifacts.push(`${path}: created during the loop, removed`);
      } catch (error) {
        artifacts.push(
          `${path}: created during the loop, could not be removed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    } else {
      artifacts.push(
        `${path}: created during the loop, kept (pass --remove-artifacts to remove it)`,
      );
    }
  }

  const after = snapshot(root);
  /** @type {Finding[]} */
  const open = arrayOf(verifiedResult(last.runDir)?.findings);
  const ownDeferrals = new Map(
    (last.fixes?.deferred ?? []).map((item) => [item.finding, item.reason]),
  );
  const summary = {
    loopDir,
    finishedAt: new Date().toISOString(),
    reason,
    maxRounds: state.maxRounds,
    roundsRun: state.rounds.length,
    rounds: state.rounds.map((round) => {
      const outcome = roundVerdict(round);
      const result = verifiedResult(round.runDir);
      /** @type {Finding[]} */
      const findings = arrayOf(result?.findings);
      return {
        round: round.round,
        runDir: round.runDir,
        verdict: outcome?.verdict ?? null,
        counts: outcome?.counts ?? null,
        fixed: round.fixes?.fixed ?? [],
        deferred: round.fixes?.deferred ?? [],
        changed: round.fixes?.changed ?? [],
        // What this round found no longer applies, and the fixes it found did not hold.
        resolved: arrayOf(result?.resolved),
        withdrawn: arrayOf(result?.withdrawn),
        reopened: findings
          .filter((finding) => typeof finding.reopens === 'string')
          .map((finding) => ({ id: finding.id, reopens: finding.reopens })),
      };
    }),
    final: {
      round: last.round,
      verdict: decided.verdict,
      counts: decided.counts,
      environmentLimitations: decided.environmentLimitations,
    },
    open: open.map((finding) => ({
      id: finding.id ?? null,
      severity: finding.severity ?? null,
      verification: finding.verification ?? null,
      title: finding.title ?? null,
      location: finding.location ?? null,
      carriedFrom: finding.carriedFrom ?? null,
      reopens: finding.reopens ?? null,
      needsDecision: ownDeferrals.get(String(finding.id)) ?? deferralOf(state, finding),
    })),
    changes: changedPaths(baseline, after).map((path) => {
      const code = after.entries[path]?.code.trim();
      return code === undefined ? `back as committed: ${path}` : `${code} ${path}`;
    }),
    violations: stateDifferences(baseline, after),
    artifacts,
    gitStatus: git(['status', '--short'], { cwd: root }).out.trim().split('\n').filter(Boolean)
      .length,
  };
  writeFileSync(join(loopDir, 'summary.json'), JSON.stringify(summary, null, 2));
  state.finished = { at: summary.finishedAt, reason };
  saveLoop(state);
  print(summary);
  if (summary.violations.length > 0) process.exitCode = 1;
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
  case 'loop': {
    const [step, ...options] = rest;
    const LOOP_ONLY = { values: ['loop'], flags: [] };
    if (step === 'start') {
      await loopStart(parseOptions(options, { values: ['base', 'mode', 'max-rounds'], flags: [] }));
    } else if (step === 'next') {
      await loopNext(parseOptions(options, LOOP_ONLY));
    } else if (step === 'status') {
      loopStatus(parseOptions(options, LOOP_ONLY));
    } else if (step === 'finish') {
      loopFinish(parseOptions(options, { values: ['loop'], flags: ['remove-artifacts'] }));
    } else {
      fail(`unknown loop step "${step ?? ''}": start, next, status or finish.\n${USAGE}`);
    }
    break;
  }
  default:
    fail(`unknown command "${command}".\n${USAGE}`);
}

// Tests of scripts/doberman.mjs (`node --test scripts/doberman.test.mjs`): the
// arguments, detection, git scopes, cleanup and verdict rules, including the
// failure and recovery paths. Every test builds a throwaway git repository in
// the system temporary folder from this template's own template.json, runs
// the engine there as a child process, and deletes it afterwards. Nothing
// touches this repository. The same file is used by both templates.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ file?: string; anyFile?: string[]; dependency?: string; package?: string }} Signal
 * @typedef {{ id: string; script?: string; requires?: string[] }} ExtraGate
 * @typedef {{
 *   template: string;
 *   aggregateScript: string;
 *   detection: { required: Signal[]; supporting: Signal[] };
 *   gates?: Record<string, { requires?: string[] }>;
 *   extraGates?: ExtraGate[];
 * }} Template
 * @typedef {{ id: string; required: boolean; plan: { run: boolean; reason: string; blockedBy: string[]; notApplicable: boolean } }} PlannedGate
 * @typedef {{ status: number | null; stdout: string; stderr: string }} Run
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, 'doberman.mjs');
const TEMPLATE_FILE = resolve(HERE, '..', '.claude', 'skills', 'doberman', 'template.json');
/** @type {Template} */
const TEMPLATE = JSON.parse(readFileSync(TEMPLATE_FILE, 'utf8'));
const ROOT = mkdtempSync(join(tmpdir(), 'doberman-test-'));
const RUNS = join(ROOT, 'runs');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'doberman-test',
  GIT_AUTHOR_EMAIL: 'doberman-test@localhost',
  GIT_COMMITTER_NAME: 'doberman-test',
  GIT_COMMITTER_EMAIL: 'doberman-test@localhost',
};
let counter = 0;

after(() => {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 });
});

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const run = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

/**
 * @param {string} dir
 * @param {string} path
 * @param {string} content
 */
function write(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/**
 * A repository with every detection signal of this template (minus `omit`),
 * the engine, the template data and a passing aggregate script, committed on
 * `main`.
 * @param {{ omit?: (signal: Signal, index: number, required: boolean) => boolean }} [options]
 */
function makeRepo({ omit = () => false } = {}) {
  counter += 1;
  const dir = join(ROOT, `repo-${counter}`);
  mkdirSync(dir, { recursive: true });
  /** @type {Map<string, Record<string, string>>} */
  const dependencies = new Map([['package.json', {}]]);
  const signals = [
    ...TEMPLATE.detection.required.map((signal, index) => ({ signal, index, required: true })),
    ...TEMPLATE.detection.supporting.map((signal, index) => ({ signal, index, required: false })),
  ];
  for (const { signal, index, required } of signals) {
    if (omit(signal, index, required)) continue;
    if (signal.file && signal.file !== 'package.json') write(dir, signal.file, 'placeholder\n');
    if (signal.anyFile?.[0]) write(dir, signal.anyFile[0], 'placeholder\n');
    if (signal.dependency) {
      const manifest = signal.package ?? 'package.json';
      const deps = dependencies.get(manifest) ?? {};
      deps[signal.dependency] = '1.0.0';
      dependencies.set(manifest, deps);
    }
  }
  const verifySteps = ['format:check', 'lint'];
  /** @type {Record<string, string>} */
  const scripts = { [TEMPLATE.aggregateScript]: verifySteps.map((s) => `pnpm ${s}`).join(' && ') };
  for (const step of verifySteps) scripts[step] = 'node -e 0';
  for (const gate of TEMPLATE.extraGates ?? []) if (gate.script) scripts[gate.script] = 'node -e 0';
  for (const [manifest, deps] of dependencies) {
    const content =
      manifest === 'package.json'
        ? { name: 'fixture', private: true, scripts, dependencies: deps }
        : { name: manifest, private: true, dependencies: deps };
    write(dir, manifest, `${JSON.stringify(content, null, 2)}\n`);
  }
  write(dir, 'scripts/doberman.mjs', readFileSync(ENGINE, 'utf8'));
  mkdirSync(join(dir, '.claude', 'skills', 'doberman'), { recursive: true });
  copyFileSync(TEMPLATE_FILE, join(dir, '.claude', 'skills', 'doberman', 'template.json'));
  write(dir, '.gitignore', 'node_modules/\n');
  git(dir, ['init', '--quiet', '--initial-branch', 'main']);
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '--no-verify', '--message', 'base']);
  return dir;
}

/**
 * Runs the engine in `dir`.
 * @param {string} dir
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Run}
 */
function engine(dir, args, env = {}) {
  const run = spawnSync(process.execPath, [join(dir, 'scripts', 'doberman.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, DOBERMAN_TMP: RUNS, ...env },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/**
 * @param {Run} run
 * @returns {any}
 */
function json(run) {
  assert.ok(run.stdout.trim().startsWith('{'), `expected JSON, got: ${run.stdout}${run.stderr}`);
  return JSON.parse(run.stdout);
}

function runCount() {
  return existsSync(RUNS) ? readdirSync(RUNS).length : 0;
}

/**
 * Starts a run and returns its context.
 * @param {string} dir
 * @param {string[]} [args]
 * @param {NodeJS.ProcessEnv} [env]
 */
function start(dir, args = [], env = {}) {
  const run = engine(dir, ['start', ...args], env);
  assert.equal(run.status, 0, run.stderr);
  return json(run);
}

/**
 * A gate log ending with the exit code line, as SKILL.md writes it.
 * @param {string} runDir
 * @param {string} id
 * @param {number | null} exit null: a gate that never finished
 */
function gateLog(runDir, id, exit) {
  const body = `output of ${id}\n${exit === null ? '' : `DOBERMAN_EXIT=${exit} DOBERMAN_SECONDS=1\n`}`;
  writeFileSync(join(runDir, 'logs', `${id.replace(/[^\w.-]/g, '-')}.log`), body);
}

/**
 * result.json from the plan: planned gates PASS with logs, the rest as the plan says.
 * @param {any} context
 * @param {{ gates?: Record<string, object>; findings?: object[]; reproductions?: object[]; logs?: boolean }} [overrides]
 */
function writeResult(context, { gates = {}, findings = [], reproductions = [], logs = true } = {}) {
  /** @type {PlannedGate[]} */
  const plan = context.gates;
  const reported = plan.map((gate) => {
    const base = gate.plan.run
      ? { id: gate.id, status: 'PASS', evidence: `logs/${gate.id}.log exit 0` }
      : {
          id: gate.id,
          status: gate.plan.notApplicable ? 'NOT APPLICABLE' : 'SKIPPED',
          reason: gate.plan.reason,
        };
    if (gate.plan.run && logs) gateLog(context.runDir, gate.id, 0);
    return { ...base, ...(gates[gate.id] ?? {}) };
  });
  writeFileSync(
    join(context.runDir, 'result.json'),
    JSON.stringify({ gates: reported, findings, reproductions }),
  );
}

/**
 * @param {string} id
 * @param {string} severity
 * @param {object} [extra]
 */
function finding(id, severity, extra = {}) {
  return {
    id,
    severity,
    verification: 'CONFIRMED',
    location: 'src/x.ts:1',
    problem: 'p',
    whyItMatters: 'w',
    reproduction: 'r',
    evidence: 'e',
    recommendation: 'x',
    ...extra,
  };
}

/**
 * Cleans and computes the verdict of a run.
 * @param {string} dir
 * @param {any} context
 */
function cleanAndDecide(dir, context) {
  engine(dir, ['clean', '--run', context.runDir]);
  return engine(dir, ['verdict', '--run', context.runDir]);
}

/** The first planned (runnable) gate that is mandatory. */
function mandatory(/** @type {any} */ context) {
  /** @type {PlannedGate | undefined} */
  const gate = context.gates.find(
    (/** @type {PlannedGate} */ item) => item.required && item.plan.run,
  );
  assert.ok(gate, 'the fixture plans at least one mandatory gate');
  return gate;
}

describe('arguments', () => {
  test('help prints the usage and starts nothing', () => {
    const dir = makeRepo();
    for (const args of [['help'], ['--help'], []]) {
      const run = engine(dir, args);
      assert.equal(run.status, 0);
      assert.match(run.stdout, /usage: node scripts\/doberman\.mjs/);
    }
    assert.equal(runCount(), 0);
  });

  test('an unknown option stops before anything is written', () => {
    const dir = makeRepo();
    const before = runCount();
    const run = engine(dir, ['start', '--bogus']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown option --bogus/);
    assert.equal(runCount(), before);
  });

  test('an option without its value, a repeated option, a positional argument and an unknown command stop', () => {
    const dir = makeRepo();
    const before = runCount();
    assert.match(engine(dir, ['start', '--mode']).stderr, /--mode needs a value/);
    assert.match(engine(dir, ['start', '--mode', 'diff', '--mode', 'full']).stderr, /given twice/);
    assert.match(engine(dir, ['start', 'extra']).stderr, /unexpected argument/);
    assert.match(engine(dir, ['frobnicate']).stderr, /unknown command/);
    assert.match(engine(dir, ['start', '--mode', 'wild']).stderr, /--mode must be one of/);
    assert.equal(runCount(), before);
  });

  test('a base that does not exist stops before anything is written', () => {
    const dir = makeRepo();
    const before = runCount();
    const run = engine(dir, ['start', '--base', 'does-not-exist']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /is not a commit/);
    assert.equal(runCount(), before);
  });

  test('a requested base is resolved', () => {
    const dir = makeRepo();
    git(dir, ['checkout', '--quiet', '-b', 'feat/x']);
    write(dir, 'new.txt', 'x\n');
    git(dir, ['add', 'new.txt']);
    git(dir, ['commit', '--quiet', '--no-verify', '--message', 'feat: x']);
    const context = start(dir, ['--base', 'main']);
    assert.equal(context.git.base.ref, 'main');
    assert.equal(context.git.base.source, 'argument');
    assert.deepEqual(
      context.git.files.map((/** @type {{ path: string }} */ file) => file.path),
      ['new.txt'],
    );
  });
});

describe('detection', () => {
  test(`a repository with this template's signals is ${TEMPLATE.template}, with its gates`, () => {
    // A whole-repository audit: the fixture's main has no change to review.
    const context = start(makeRepo(), ['--mode', 'full']);
    assert.equal(context.detection.projectType, TEMPLATE.template);
    assert.deepEqual(context.blockers, []);
    assert.ok(context.gates.length > 0);
  });

  test('a repository of another kind is UNKNOWN, with no gates and the reason', () => {
    const context = start(makeRepo({ omit: () => true }), ['--mode', 'full']);
    assert.equal(context.detection.projectType, 'UNKNOWN');
    assert.deepEqual(context.gates, []);
    assert.equal(context.blockers.length, 1);
    assert.match(context.blockers[0], /not a .* repository: stop \(missing:/);
  });

  test('one matching dependency or file is not enough (no false positive)', () => {
    const context = start(
      makeRepo({ omit: (_signal, index, required) => !(required && index <= 1) }),
    );
    assert.equal(context.detection.projectType, 'UNKNOWN');
    assert.deepEqual(context.gates, []);
  });

  test('a single missing required signal (another template, a fork) is UNKNOWN', () => {
    const last = TEMPLATE.detection.required.length - 1;
    const context = start(
      makeRepo({ omit: (_signal, index, required) => required && index === last }),
    );
    assert.equal(context.detection.projectType, 'UNKNOWN');
  });
});

describe('git scopes', () => {
  test('renamed, deleted, staged, unstaged and untracked changes are all in scope', () => {
    const dir = makeRepo();
    write(dir, 'a.txt', 'a\n'.repeat(20));
    write(dir, 'b.txt', 'b\n');
    write(dir, 'c.txt', 'c\n');
    write(dir, 'e.txt', 'e\n');
    git(dir, ['add', '--all']);
    git(dir, ['commit', '--quiet', '--no-verify', '--message', 'files']);
    git(dir, ['checkout', '--quiet', '-b', 'feat/scope']);
    git(dir, ['mv', 'a.txt', 'a2.txt']);
    git(dir, ['rm', '--quiet', 'b.txt']);
    git(dir, ['commit', '--quiet', '--no-verify', '--message', 'rename and delete']);
    write(dir, 'c.txt', 'c changed\n');
    git(dir, ['add', 'c.txt']);
    write(dir, 'e.txt', 'e changed\n');
    write(dir, 'd.txt', 'd\n');
    const context = start(dir);
    /** @type {Record<string, { status: string; origin: string }>} */
    const byPath = Object.fromEntries(
      context.git.files.map((/** @type {{ path: string; status: string; origin: string }} */ f) => [
        f.path,
        f,
      ]),
    );
    assert.equal(byPath['a2.txt']?.status, 'R');
    assert.equal(byPath['b.txt']?.status, 'D');
    assert.equal(byPath['c.txt']?.origin, 'uncommitted');
    assert.equal(byPath['d.txt']?.origin, 'untracked');
    assert.equal(byPath['e.txt']?.status, 'M');
    assert.equal(context.git.commits.length, 1);
  });

  test('a branch without commits of its own is on its base: nothing to review, said as a blocker', () => {
    const dir = makeRepo();
    git(dir, ['checkout', '--quiet', '-b', 'feat/empty']);
    const context = start(dir);
    assert.equal(context.git.onBaseBranch, true);
    assert.equal(context.git.files.length, 0);
    assert.ok(
      context.blockers.some((/** @type {string} */ b) => b.startsWith('nothing to review')),
    );
    // A whole-repository audit is still possible.
    assert.equal(start(dir, ['--mode', 'full']).blockers.length, 0);
  });

  test('a branch without history in common with its base is a blocker, not an empty review', () => {
    const dir = makeRepo();
    git(dir, ['checkout', '--quiet', '--orphan', 'unrelated']);
    git(dir, ['commit', '--quiet', '--no-verify', '--message', 'unrelated root']);
    const context = start(dir, ['--base', 'main']);
    assert.equal(context.git.mergeBase, null);
    assert.ok(context.blockers.some((/** @type {string} */ b) => /share no history/.test(b)));
  });

  test('a repository without commits is a full audit of everything staged or new', () => {
    counter += 1;
    const dir = join(ROOT, `repo-${counter}`);
    const source = makeRepo();
    mkdirSync(dir);
    for (const entry of readdirSync(source)) {
      if (entry !== '.git') {
        cpSync(join(source, entry), join(dir, entry), { recursive: true });
      }
    }
    git(dir, ['init', '--quiet', '--initial-branch', 'main']);
    git(dir, ['add', '--all']);
    const context = start(dir);
    assert.equal(context.git.unborn, true);
    assert.equal(context.mode, 'full');
    assert.ok(context.git.files.length > 0);
  });
});

describe('environment', () => {
  test("a Node.js outside the project's engines is reported, one inside is accepted", () => {
    const dir = makeRepo();
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const [range, satisfied] of [
      ['>=999.0.0', false],
      [`^${process.versions.node.split('.')[0] ?? '0'}.0.0 || >=999.0.0`, true],
      ['>=1.0.0', true],
    ]) {
      manifest.engines = { node: range };
      write(dir, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`);
      const context = start(dir);
      assert.equal(context.environment.nodeEngines.satisfied, satisfied, String(range));
    }
  });

  test('a missing tool skips the gates that need it, with the reason', () => {
    /** @param {string} name */
    const dirOf = (name) => {
      const extensions = process.platform === 'win32' ? ['.exe', ''] : [''];
      for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        for (const extension of extensions) {
          if (dir !== '' && existsSync(join(dir, `${name}${extension}`))) return dir;
        }
      }
      return null;
    };
    const gitDir = dirOf('git');
    assert.ok(gitDir, 'git is on PATH');
    // Only node and git on PATH. On Linux and macOS git usually shares its
    // directory with docker (/usr/bin), so links to the two programs go in a
    // directory of their own; Windows keeps them in separate directories.
    let PATH = [dirname(process.execPath), gitDir].join(delimiter);
    if (process.platform !== 'win32') {
      const bin = mkdtempSync(join(ROOT, 'path-'));
      symlinkSync(process.execPath, join(bin, 'node'));
      symlinkSync(join(gitDir, 'git'), join(bin, 'git'));
      PATH = bin;
    }
    const context = start(makeRepo(), [], { PATH, Path: PATH });
    assert.equal(context.environment.docker?.available ?? false, false);
    /** @type {PlannedGate[]} */
    const needingDocker = context.gates.filter(
      (/** @type {PlannedGate & { requires: string[] }} */ gate) =>
        gate.requires.includes('docker'),
    );
    for (const gate of needingDocker) {
      if (gate.plan.notApplicable) continue;
      assert.equal(gate.plan.run, false, `${gate.id} must not run without docker`);
      assert.ok(gate.plan.blockedBy.includes('docker'), gate.plan.reason);
    }
  });
});

describe('cleanup', () => {
  test('changes made before the run are kept, and the run is clean', () => {
    const dir = makeRepo();
    write(dir, 'package.json', `${readFileSync(join(dir, 'package.json'), 'utf8')}\n`);
    write(dir, 'staged.txt', 'staged\n');
    git(dir, ['add', 'staged.txt']);
    write(dir, 'untracked.txt', 'mine\n');
    const before = ['package.json', 'staged.txt', 'untracked.txt'].map((p) =>
      readFileSync(join(dir, p), 'utf8'),
    );
    const context = start(dir);
    const result = json(engine(dir, ['clean', '--run', context.runDir]));
    assert.equal(result.clean, true, JSON.stringify(result));
    const afterwards = ['package.json', 'staged.txt', 'untracked.txt'].map((p) =>
      readFileSync(join(dir, p), 'utf8'),
    );
    assert.deepEqual(afterwards, before);
  });

  test("only this run's marked files are deleted", () => {
    const dir = makeRepo();
    write(dir, 'src/earlier.doberman.spec.ts', '// DOBERMAN-TEMPORARY: from another run\n');
    const context = start(dir);
    write(dir, 'src/repro.doberman.spec.ts', '// DOBERMAN-TEMPORARY: R1\n');
    write(dir, 'src/unmarked.doberman.spec.ts', 'export {};\n');
    const run = engine(dir, ['clean', '--run', context.runDir]);
    const result = json(run);
    assert.deepEqual(result.removed, ['src/repro.doberman.spec.ts']);
    assert.equal(existsSync(join(dir, 'src/repro.doberman.spec.ts')), false);
    assert.equal(existsSync(join(dir, 'src/earlier.doberman.spec.ts')), true);
    assert.equal(existsSync(join(dir, 'src/unmarked.doberman.spec.ts')), true);
    assert.equal(result.clean, false);
    assert.equal(result.leftovers.length, 2);
    assert.equal(run.status, 1);
  });

  test('a deletion that fails (a locked directory) is reported, never a crash or a clean run', async () => {
    const dir = makeRepo();
    const context = start(dir);
    assert.equal(engine(dir, ['sandbox', '--run', context.runDir]).status, 0);
    const sandbox = join(context.runDir, 'sandbox');
    /** @type {import('node:child_process').ChildProcess | null} */
    let holder = null;
    if (process.platform === 'win32') {
      // Windows refuses to delete a directory a process is working in.
      holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: sandbox });
      await new Promise((done) => setTimeout(done, 500));
    } else {
      // Elsewhere, entries of a directory without write permission cannot
      // be removed. The run directory stays writable for clean.json.
      chmodSync(sandbox, 0o555);
    }
    try {
      const run = engine(dir, ['clean', '--run', context.runDir]);
      const result = json(run);
      assert.equal(run.status, 1);
      assert.equal(result.clean, false);
      assert.ok(
        result.failures.some((/** @type {string} */ f) => f.startsWith('sandbox:')),
        JSON.stringify(result),
      );
    } finally {
      holder?.kill();
      if (process.platform !== 'win32') chmodSync(sandbox, 0o755);
    }
  });

  test('a cleanup record that cannot be written is reported, never a crash', () => {
    const dir = makeRepo();
    const context = start(dir);
    // A directory where the file goes: no platform can write it.
    mkdirSync(join(context.runDir, 'clean.json'));
    const run = engine(dir, ['clean', '--run', context.runDir]);
    const result = json(run);
    assert.equal(run.status, 1);
    assert.equal(result.clean, false);
    assert.ok(
      result.failures.some((/** @type {string} */ f) => f.startsWith('clean.json:')),
      JSON.stringify(result),
    );
  });

  test('clean and sandbox refuse to act on another repository than the run belongs to', () => {
    const dir = makeRepo();
    const other = makeRepo();
    const context = start(dir);
    for (const args of [
      ['clean', '--run', context.runDir],
      ['sandbox', '--run', context.runDir],
    ]) {
      const run = spawnSync(process.execPath, [ENGINE, ...args], {
        cwd: other,
        encoding: 'utf8',
        env: { ...process.env, DOBERMAN_TMP: RUNS },
      });
      assert.equal(run.status, 2, args[0]);
      assert.match(run.stderr, /this run belongs to/);
    }
  });

  test('a symbolic link named like a temporary file is never deleted, nor its target', (t) => {
    const dir = makeRepo();
    const outside = join(ROOT, `outside-${counter}.ts`);
    writeFileSync(outside, '// DOBERMAN-TEMPORARY: not this run\n');
    const context = start(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    try {
      symlinkSync(outside, join(dir, 'src', 'link.doberman.spec.ts'));
    } catch (error) {
      t.skip(`this system does not allow creating symbolic links (${String(error)})`);
      return;
    }
    const result = json(engine(dir, ['clean', '--run', context.runDir]));
    assert.ok(existsSync(join(dir, 'src', 'link.doberman.spec.ts')));
    assert.ok(existsSync(outside));
    assert.ok(result.leftovers.some((/** @type {string} */ l) => l.includes('symbolic link')));
  });

  test('the sandbox never follows a symbolic link out of the repository', (t) => {
    const dir = makeRepo();
    const outside = join(ROOT, `secret-${counter}.txt`);
    writeFileSync(outside, 'not part of the change\n');
    try {
      symlinkSync(outside, join(dir, 'linked.txt'));
    } catch (error) {
      t.skip(`this system does not allow creating symbolic links (${String(error)})`);
      return;
    }
    const context = start(dir);
    const result = json(engine(dir, ['sandbox', '--run', context.runDir]));
    assert.deepEqual(result.skippedLinks, ['linked.txt']);
    assert.equal(existsSync(join(context.runDir, 'sandbox', 'linked.txt')), false);
  });

  test('a run directory is never reused', () => {
    const dir = makeRepo();
    const first = start(dir);
    const second = start(dir);
    assert.notEqual(first.runDir, second.runDir);
  });

  test('a run directory is private to its user', { skip: process.platform === 'win32' }, () => {
    const { runDir } = start(makeRepo());
    assert.equal(statSync(runDir).mode & 0o777, 0o700);
  });

  test(
    'a runs directory others may write into is refused before anything is written',
    { skip: process.platform === 'win32' },
    () => {
      const shared = join(ROOT, 'shared-runs');
      mkdirSync(shared);
      chmodSync(shared, 0o777);
      const run = engine(makeRepo(), ['start'], { DOBERMAN_TMP: shared });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /is not a private directory of yours/);
      assert.deepEqual(readdirSync(shared), []);
    },
  );
});

describe('verdict', () => {
  test('result.json that is not valid JSON is refused', () => {
    const dir = makeRepo();
    const context = start(dir);
    writeFileSync(join(context.runDir, 'result.json'), '{ not json');
    engine(dir, ['clean', '--run', context.runDir]);
    const run = engine(dir, ['verdict', '--run', context.runDir]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /not valid JSON/);
  });

  test('an incomplete result (a planned gate missing, empty finding fields, duplicates) is invalid', () => {
    const dir = makeRepo();
    const context = start(dir);
    const gate = mandatory(context);
    writeResult(context, { findings: [{ id: 'F1', severity: 'BLOCKING' }, finding('F1', 'LOW')] });
    const result = JSON.parse(readFileSync(join(context.runDir, 'result.json'), 'utf8'));
    result.gates = result.gates.filter((/** @type {{ id: string }} */ g) => g.id !== gate.id);
    writeFileSync(join(context.runDir, 'result.json'), JSON.stringify(result));
    const output = json(cleanAndDecide(dir, context));
    assert.equal(output.valid, false);
    assert.equal(output.verdict, null);
    const errors = output.errors.join('\n');
    assert.match(errors, /in the plan but not in result\.gates/);
    assert.match(errors, /"problem" is empty/);
    assert.match(errors, /finding F1 appears more than once/);
  });

  test('the verdict needs the cleanup first', () => {
    const dir = makeRepo();
    const context = start(dir);
    writeResult(context);
    const output = json(engine(dir, ['verdict', '--run', context.runDir]));
    assert.equal(output.valid, false);
    assert.match(output.errors.join('\n'), /cleanup has not run/);
  });

  test('every gate passed and no findings: READY TO MERGE, with the note that it proves no absence', () => {
    const dir = makeRepo();
    const context = start(dir, [], { PATH: process.env.PATH });
    writeResult(context, {
      gates: Object.fromEntries(
        context.gates
          .filter((/** @type {PlannedGate} */ g) => !g.plan.run && !g.plan.notApplicable)
          .map((/** @type {PlannedGate} */ g) => [
            g.id,
            { status: 'SKIPPED', reason: g.plan.reason },
          ]),
      ),
    });
    const output = json(cleanAndDecide(dir, context));
    assert.equal(output.valid, true, output.errors.join('\n'));
    const limited = context.gates.some(
      (/** @type {PlannedGate} */ g) =>
        (g.required && !g.plan.run && !g.plan.notApplicable) || g.plan.blockedBy.length > 0,
    );
    assert.equal(output.verdict, limited ? 'READY WITH ENVIRONMENT LIMITATIONS' : 'READY TO MERGE');
    assert.match(output.note, /does not prove/);
  });

  test('a mandatory gate that failed, with its BLOCKING finding: DO NOT MERGE', () => {
    const dir = makeRepo();
    const context = start(dir);
    const gate = mandatory(context);
    writeResult(context, {
      gates: { [gate.id]: { status: 'FAIL', evidence: 'exit 1' } },
      findings: [finding('F1', 'BLOCKING', { gate: gate.id })],
    });
    gateLog(context.runDir, gate.id, 1);
    const output = json(cleanAndDecide(dir, context));
    assert.equal(output.verdict, 'DO NOT MERGE', output.errors.join('\n'));
  });

  test('a failed gate without a finding, or a mandatory one explained only by a LOW, is invalid', () => {
    const dir = makeRepo();
    const context = start(dir);
    const gate = mandatory(context);
    writeResult(context, { gates: { [gate.id]: { status: 'FAIL', evidence: 'exit 1' } } });
    gateLog(context.runDir, gate.id, 1);
    let output = json(cleanAndDecide(dir, context));
    assert.match(output.errors.join('\n'), /no finding explains it/);
    writeResult(context, {
      gates: { [gate.id]: { status: 'FAIL', evidence: 'exit 1' } },
      findings: [finding('F1', 'LOW', { gate: gate.id })],
    });
    gateLog(context.runDir, gate.id, 1);
    output = json(engine(dir, ['verdict', '--run', context.runDir]));
    assert.match(output.errors.join('\n'), /must be BLOCKING/);
  });

  test('a mandatory gate skipped for the environment: READY WITH ENVIRONMENT LIMITATIONS', () => {
    const dir = makeRepo();
    const context = start(dir);
    const gate = mandatory(context);
    writeResult(context, {
      gates: { [gate.id]: { status: 'SKIPPED', reason: 'REQUIRES DOCKER' } },
    });
    const output = json(cleanAndDecide(dir, context));
    assert.equal(output.verdict, 'READY WITH ENVIRONMENT LIMITATIONS');
    assert.ok(
      output.environmentLimitations.some((/** @type {string} */ l) =>
        l.includes('REQUIRES DOCKER'),
      ),
    );
  });

  test('a PASS its log does not back is refused: no log, a non-zero exit, a gate that never finished', () => {
    const dir = makeRepo();
    const context = start(dir);
    const gate = mandatory(context);
    writeResult(context, { logs: false });
    let output = json(cleanAndDecide(dir, context));
    assert.match(output.errors.join('\n'), /has no DOBERMAN_EXIT line/);
    gateLog(context.runDir, gate.id, 1);
    output = json(engine(dir, ['verdict', '--run', context.runDir]));
    assert.ok(
      output.errors.includes(`gate ${gate.id}: reported PASS but its log ends with exit 1`),
      output.errors.join('\n'),
    );
    gateLog(context.runDir, gate.id, null);
    output = json(engine(dir, ['verdict', '--run', context.runDir]));
    assert.ok(
      output.errors.some(
        (/** @type {string} */ error) =>
          error.startsWith(`gate ${gate.id}: PASS but`) && error.includes('did not finish'),
      ),
      output.errors.join('\n'),
    );
  });

  test('a FAIL whose log ends with exit 0 is refused', () => {
    const dir = makeRepo();
    const context = start(dir);
    const gate = mandatory(context);
    writeResult(context, {
      gates: { [gate.id]: { status: 'FAIL', evidence: 'x' } },
      findings: [finding('F1', 'BLOCKING', { gate: gate.id })],
    });
    const output = json(cleanAndDecide(dir, context));
    assert.match(output.errors.join('\n'), /reported FAIL but its log ends with exit 0/);
  });

  test('a gate cut off by a timeout reported UNVERIFIED: valid, and a limitation', () => {
    const dir = makeRepo();
    const context = start(dir);
    const gate = mandatory(context);
    writeResult(context, {
      gates: { [gate.id]: { status: 'UNVERIFIED', reason: 'timed out after 600 s' } },
    });
    gateLog(context.runDir, gate.id, null);
    const output = json(cleanAndDecide(dir, context));
    assert.equal(output.valid, true, output.errors.join('\n'));
    assert.equal(output.verdict, 'READY WITH ENVIRONMENT LIMITATIONS');
  });

  test("a real child process's non-zero exit code is what the log records", () => {
    const dir = makeRepo();
    const context = start(dir);
    const gate = mandatory(context);
    const child = spawnSync(process.execPath, ['-e', 'console.log("checking"); process.exit(3)'], {
      encoding: 'utf8',
    });
    writeFileSync(
      join(context.runDir, 'logs', `${gate.id.replace(/[^\w.-]/g, '-')}.log`),
      `${child.stdout}DOBERMAN_EXIT=${child.status ?? 'none'}\n`,
    );
    writeResult(context, { logs: false });
    for (const other of context.gates) {
      if (other.id !== gate.id && other.plan.run) gateLog(context.runDir, other.id, 0);
    }
    const output = json(cleanAndDecide(dir, context));
    assert.match(output.errors.join('\n'), /reported PASS but its log ends with exit 3/);
  });

  test('a BLOCKING finding with every gate passed: DO NOT MERGE', () => {
    const dir = makeRepo();
    const context = start(dir);
    writeResult(context, { findings: [finding('F1', 'BLOCKING')] });
    assert.equal(json(cleanAndDecide(dir, context)).verdict, 'DO NOT MERGE');
  });

  test('a SHOULD FIX and no BLOCKING: CHANGES REQUIRED; UNVERIFIED findings do not count', () => {
    const dir = makeRepo();
    const context = start(dir);
    writeResult(context, {
      findings: [
        finding('F1', 'SHOULD FIX'),
        finding('F2', 'BLOCKING', { verification: 'UNVERIFIED' }),
      ],
    });
    const output = json(cleanAndDecide(dir, context));
    assert.equal(output.verdict, 'CHANGES REQUIRED');
    assert.equal(output.counts.UNVERIFIED, 1);
  });

  test('REPRODUCED needs a reproduction that reproduced', () => {
    const dir = makeRepo();
    const context = start(dir);
    writeResult(context, {
      findings: [finding('F1', 'BLOCKING', { verification: 'REPRODUCED', reproductionId: 'R1' })],
      reproductions: [{ id: 'R1', status: 'NOT REPRODUCED', evidence: 'passed' }],
    });
    const output = json(cleanAndDecide(dir, context));
    assert.match(output.errors.join('\n'), /REPRODUCED needs reproductionId/);
  });

  test('a secret in result.json is refused, and the error never repeats it', () => {
    const dir = makeRepo();
    const value = 'fixture-only-secret-value-0123456789';
    write(dir, '.env', `JWT_ACCESS_SECRET=${value}\nPUBLIC_NAME=visible\n`);
    const context = start(dir);
    const key = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    writeResult(context, {
      findings: [finding('F1', 'LOW', { evidence: `${key} and ${value} in the log` })],
    });
    const output = json(cleanAndDecide(dir, context));
    const errors = output.errors.join('\n');
    assert.match(errors, /contains a private key/);
    assert.match(errors, /the value of JWT_ACCESS_SECRET from \.env/);
    assert.equal(errors.includes(value), false);
  });

  test('a workspace the run did not leave clean is never READY TO MERGE', () => {
    const dir = makeRepo();
    const context = start(dir);
    write(dir, 'stray.txt', 'left behind\n');
    writeResult(context);
    const output = json(cleanAndDecide(dir, context));
    assert.notEqual(output.verdict, 'READY TO MERGE');
    assert.ok(
      output.environmentLimitations.some((/** @type {string} */ l) =>
        l.startsWith('CLEANUP INCOMPLETE'),
      ),
    );
  });
});

describe('interruption', () => {
  test('an interrupted run says so; a finished one says finished', () => {
    const dir = makeRepo();
    const context = start(dir);
    let state = json(engine(dir, ['status', '--run', context.runDir]));
    assert.equal(state.phase, 'incomplete');
    assert.equal(state.cleaned, 'not run');
    assert.ok(state.plannedGatesWithoutFinishedLog.length > 0);
    writeResult(context);
    assert.equal(cleanAndDecide(dir, context).status, 0);
    state = json(engine(dir, ['status', '--run', context.runDir]));
    assert.equal(state.phase, 'finished');
    assert.deepEqual(state.plannedGatesWithoutFinishedLog, []);
  });
});

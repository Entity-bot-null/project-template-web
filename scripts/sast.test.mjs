// Tests of scripts/sast.mjs (`node --test scripts/sast.test.mjs`): which
// files the Semgrep scan receives, that the temporary copy is removed in
// every case, and that Semgrep's exit status is passed through. Semgrep
// itself is replaced by a recording stand-in: the real scan is `pnpm sast`.
// Every test works on a throwaway git repository in the temporary folder.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { copyToTemp, RULESETS, scan, selectFiles } from './sast.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'sast-test-'));
let counter = 0;

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
}

/**
 * A repository with tracked, untracked, ignored and dependency files.
 * @returns {string}
 */
function makeRepo() {
  counter += 1;
  const dir = join(ROOT, `repo ${counter} (spaced)`);
  /** @type {Record<string, string>} */
  const files = {
    '.gitignore': 'node_modules/\ndist/\n.env\ncoverage/\n',
    '.semgrepignore': 'generated/\n',
    'apps/api/src/main.ts': 'export {};\n',
    'apps/api/Dockerfile': 'FROM node:24\n',
    'apps/web/nginx/default.conf': 'server {}\n',
    '.github/workflows/ci.yml': 'on: push\n',
    'generated/schema.ts': 'export {};\n',
    'docs/ñandú y espacios.md': '# special name\n',
    'node_modules/pkg/index.js': 'module.exports = {};\n',
    'dist/bundle.js': 'built\n',
    '.env': 'SECRET=local\n',
    'coverage/lcov.info': 'TN:\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, ['init', '--quiet']);
  git(dir, ['add', '.gitignore', '.semgrepignore', 'apps', '.github', 'generated']);
  // docs/ stays untracked: new files are scanned too.
  return dir;
}

/** Files under a directory, relative, sorted. */
function listTree(/** @type {string} */ dir, /** @type {string} */ prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listTree(dir, path));
    else out.push(path);
  }
  return out.sort();
}

describe('file selection', () => {
  test('tracked and new files, never ignored ones, dependencies or build output', () => {
    const { files } = selectFiles(makeRepo());
    assert.deepEqual(files, [
      '.github/workflows/ci.yml',
      '.gitignore',
      '.semgrepignore',
      'apps/api/Dockerfile',
      'apps/api/src/main.ts',
      'apps/web/nginx/default.conf',
      'docs/ñandú y espacios.md',
      'generated/schema.ts',
    ]);
  });

  test('.semgrepignore is copied, so Semgrep applies it to the copy as before', () => {
    const dir = makeRepo();
    const { files } = selectFiles(dir);
    const copy = copyToTemp(files, dir);
    try {
      assert.equal(readFileSync(join(copy, '.semgrepignore'), 'utf8'), 'generated/\n');
      assert.deepEqual(listTree(copy), files);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  test('a deleted tracked file is left out', () => {
    const dir = makeRepo();
    rmSync(join(dir, 'apps/api/Dockerfile'));
    assert.equal(selectFiles(dir).files.includes('apps/api/Dockerfile'), false);
  });

  test('a symbolic link is reported and not followed', (t) => {
    const dir = makeRepo();
    const outside = join(ROOT, `outside-${counter}.txt`);
    writeFileSync(outside, 'not in the repository\n');
    try {
      symlinkSync(outside, join(dir, 'link.txt'));
    } catch (error) {
      t.skip(`this system does not allow creating symbolic links (${String(error)})`);
      return;
    }
    const { files, links } = selectFiles(dir);
    assert.deepEqual(links, ['link.txt']);
    assert.equal(files.includes('link.txt'), false);
  });
});

describe('scan', () => {
  test("mounts the copy, not the repository, with the same rulesets, and passes Semgrep's status through", async () => {
    const dir = makeRepo();
    /** @type {{ name: string; args: string[]; options: Record<string, unknown>; tree: string[] }[]} */
    const calls = [];
    for (const status of [0, 1, 2]) {
      const result = await scan({
        root: dir,
        log: () => undefined,
        run: (name, args, options = {}) => {
          const source = String(options.source);
          calls.push({ name, args, options, tree: listTree(source) });
          return status;
        },
      });
      assert.equal(result, status);
    }
    const [first] = calls;
    assert.ok(first);
    assert.equal(first.name, 'semgrep');
    assert.equal(first.options.mount, '/src');
    assert.notEqual(first.options.source, dir);
    assert.deepEqual(first.tree, selectFiles(dir).files);
    assert.deepEqual(
      first.args.filter((_arg, index) => first.args[index - 1] === '--config'),
      RULESETS,
    );
    assert.ok(first.args.includes('--error'));
  });

  test('the copy is removed after a pass, a failure and an exception', async () => {
    const dir = makeRepo();
    /** @type {string[]} */
    const sources = [];
    /** @param {number | Error} outcome */
    const run = (outcome) => () =>
      scan({
        root: dir,
        log: () => undefined,
        run: (_name, _args, options = {}) => {
          sources.push(String(options.source));
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
      });
    assert.equal(await run(0)(), 0);
    assert.equal(await run(1)(), 1);
    await assert.rejects(run(new Error('docker vanished')), /docker vanished/);
    assert.equal(sources.length, 3);
    for (const source of sources) assert.equal(existsSync(source), false, source);
  });

  test('a SIGTERM during the scan removes the copy and exits 143 (POSIX signals)', async (t) => {
    if (process.platform === 'win32') {
      t.skip('Windows ends a process without running its signal handlers: not testable here');
      return;
    }
    const dir = makeRepo();
    // The stand-in for Semgrep runs a child process for 2 s, like docker run.
    const script = `
      import { spawnSync } from 'node:child_process';
      import { scan } from ${JSON.stringify(new URL('./sast.mjs', import.meta.url).href)};
      process.exit(await scan({ root: ${JSON.stringify(dir)}, log: () => undefined, run: (_n, _a, o) => {
        console.log(String(o.source));
        spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
        return 0;
      } }));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
    /** @type {string} */
    const source = await new Promise((done) => {
      child.stdout.once('data', (/** @type {Buffer} */ chunk) => {
        done(chunk.toString().trim());
      });
    });
    child.kill('SIGTERM');
    /** @type {number | null} */
    const code = await new Promise((done) => {
      child.once('exit', (exit) => {
        done(exit);
      });
    });
    assert.equal(code, 143, 'the handler ran (without it the process dies by the signal)');
    assert.equal(existsSync(source), false);
  });
});

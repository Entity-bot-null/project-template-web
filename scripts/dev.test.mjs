// Tests of the `pnpm dev` runner (scripts/dev.mjs). Run: pnpm test:scripts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { answers, apiReadyWatcher, pnpmCommand, resolvedExecPath } from './dev.mjs';

const READY =
  'apps/api dev: [Nest] 158233  - 12/10/2026, 16:44:24     LOG [NestApplication] Nest application successfully started';

/** A watcher and how many times it has called back. */
function counting() {
  let calls = 0;
  const watch = apiReadyWatcher(() => {
    calls++;
  });
  return { watch, calls: () => calls };
}

describe('apiReadyWatcher', () => {
  test("calls back on the API's start-up line, with pnpm's prefix", () => {
    const { watch, calls } = counting();
    watch(`apps/api dev: [Nest] LOG [InstanceLoader] AppModule dependencies initialized\n`);
    assert.equal(calls(), 0);
    watch(`${READY}\n`);
    assert.equal(calls(), 1);
  });

  test('colors around the words do not hide it', () => {
    const { watch, calls } = counting();
    watch(
      '\u001b[32m[Nest] 1  - \u001b[39m\u001b[32m    LOG\u001b[39m \u001b[33m[NestApplication] \u001b[39m\u001b[32mNest application successfully started\u001b[39m\n',
    );
    assert.equal(calls(), 1);
  });

  test('a line split across chunks counts once it is complete', () => {
    const { watch, calls } = counting();
    const middle = READY.indexOf('successfully');
    watch(READY.slice(0, middle));
    assert.equal(calls(), 0);
    watch(`${READY.slice(middle)}\napps/web dev: hmr update /src/App.tsx\n`);
    assert.equal(calls(), 1);
  });

  test('each restart after a change calls back again', () => {
    const { watch, calls } = counting();
    watch(`${READY}\napps/api dev: File change detected. Starting incremental compilation...\n`);
    watch(`${READY}\n`);
    assert.equal(calls(), 2);
  });
});

describe('pnpmCommand', () => {
  const ARGS = ['--parallel', 'dev'];

  test('a JavaScript entry point runs with this Node.js, never through a shell', () => {
    for (const entry of ['/opt/pnpm/bin/pnpm.mjs', 'C:\\pnpm\\bin\\pnpm.cjs', '/x/pnpm.js']) {
      assert.deepEqual(pnpmCommand(entry, ARGS), [process.execPath, [entry, ...ARGS]]);
    }
  });

  test('a native binary runs as it is', () => {
    assert.deepEqual(pnpmCommand('/usr/local/bin/pnpm', ARGS), ['/usr/local/bin/pnpm', ARGS]);
    assert.deepEqual(pnpmCommand('C:\\pnpm\\pnpm.exe', ARGS), ['C:\\pnpm\\pnpm.exe', ARGS]);
  });

  test('without npm_execpath, pnpm from the PATH', () => {
    assert.deepEqual(pnpmCommand(undefined, ARGS), ['pnpm', ARGS]);
    assert.deepEqual(pnpmCommand('', ARGS), ['pnpm', ARGS]);
  });
});

describe('resolvedExecPath', () => {
  test('a link is followed to the file it points at (npm installs pnpm as a link)', (context) => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-execpath-'));
    context.after(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const entry = join(dir, 'pnpm.mjs');
    writeFileSync(entry, '');
    symlinkSync(entry, join(dir, 'pnpm'));
    assert.equal(resolvedExecPath(join(dir, 'pnpm')), entry);
  });

  test('a path that cannot be resolved is kept as given, never a crash', () => {
    const missing = join(tmpdir(), 'no-such-dir-dev-execpath', 'pnpm.mjs');
    assert.equal(resolvedExecPath(missing), missing);
  });

  test('unset or empty stays unset', () => {
    assert.equal(resolvedExecPath(undefined), undefined);
    assert.equal(resolvedExecPath(''), undefined);
  });
});

describe('answers', () => {
  /** A local HTTP server; its URL and a way to close it. */
  async function server() {
    const http = createServer((_request, response) => response.end('ok'));
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = /** @type {import('node:net').AddressInfo} */ (http.address());
    return { url: `http://127.0.0.1:${String(address.port)}/`, close: () => http.close() };
  }

  test('true as soon as the URL answers', async () => {
    const { url, close } = await server();
    try {
      assert.equal(await answers(url, new AbortController().signal), true);
    } finally {
      close();
    }
  });

  test('false at once when the servers stop while it waits, instead of waiting it out', async () => {
    const { url, close } = await server();
    close(); // nothing listens there any more: every attempt is refused
    const stopped = new AbortController();
    setTimeout(() => {
      stopped.abort();
    }, 300);
    const started = Date.now();
    assert.equal(await answers(url, stopped.signal), false);
    assert.ok(Date.now() - started < 2_000, `took ${String(Date.now() - started)} ms`);
  });

  test('false without trying when already stopped', async () => {
    const stopped = new AbortController();
    stopped.abort();
    assert.equal(await answers('http://127.0.0.1:9/', stopped.signal), false);
  });
});

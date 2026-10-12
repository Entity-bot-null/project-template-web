// Tests of the `pnpm dev` runner (scripts/dev.mjs). Run: pnpm test:scripts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { apiReadyWatcher } from './dev.mjs';

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

// Tests of scripts/recorded-images.mjs: which earlier Deploy run's record of
// an image the next deployment of the same commit may reuse. GitHub's API and
// git are replaced by stand-ins. Run: pnpm test:scripts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findRecord, recordName } from './recorded-images.mjs';

const REPO = 'acme/app';
const SHA = 'a'.repeat(40);
const ON_MAIN = 'b'.repeat(40);
const OFF_MAIN = 'c'.repeat(40);
const DEPLOY = 101; // this workflow's id
const THIS_RUN = 9000;

/**
 * A REST API stand-in: the runs by id, and the artifacts by name.
 * @param {Record<number, Record<string, unknown>>} runs
 * @param {Record<string, unknown>[]} artifacts newest first, as the API lists them
 */
function api(runs, artifacts) {
  /** @type {string[]} */
  const paths = [];
  /** @param {string} path */
  const request = (path) => {
    paths.push(path);
    const run = /^\/repos\/acme\/app\/actions\/runs\/(\d+)$/.exec(path);
    if (run) {
      const found = runs[Number(run[1])];
      if (found === undefined) return Promise.reject(new Error(`404 ${path}`));
      return Promise.resolve(found);
    }
    if (path.startsWith('/repos/acme/app/actions/artifacts?')) {
      const name = new URL(path, 'https://api.example').searchParams.get('name');
      return Promise.resolve({ artifacts: artifacts.filter((artifact) => artifact.name === name) });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  };
  return { request, paths };
}

/** @param {number} id @param {Record<string, unknown>} [fields] */
const deployRun = (id, fields = {}) => ({
  id,
  workflow_id: DEPLOY,
  head_sha: ON_MAIN,
  head_repository: { full_name: REPO },
  ...fields,
});

/** @param {number} runId @param {string} [image] @param {Record<string, unknown>} [fields] */
const record = (runId, image = 'api', fields = {}) => ({
  name: recordName(image, SHA),
  expired: false,
  created_at: `2026-10-10T10:00:${String(runId).padStart(2, '0')}Z`,
  workflow_run: { id: runId },
  ...fields,
});

/** @param {string} sha */
const isOnMain = (sha) => sha === ON_MAIN;

/** @param {ReturnType<typeof api>} stub @param {string} [image] */
const find = (stub, image = 'api') =>
  findRecord({
    repository: REPO,
    runId: THIS_RUN,
    sha: SHA,
    image,
    request: stub.request,
    isOnMain,
  });

describe('findRecord', () => {
  test('reuses the newest record of an earlier run of this workflow from main', async () => {
    // Listed out of order, as the API can: the creation time decides.
    const stub = api({ [THIS_RUN]: deployRun(THIS_RUN), 7: deployRun(7), 5: deployRun(5) }, [
      record(5),
      record(7),
    ]);
    assert.equal(await find(stub), 7);
    assert.ok(stub.paths.some((path) => path.includes(`name=${recordName('api', SHA)}`)));
  });

  test('none: nothing recorded for this image and commit', async () => {
    const stub = api({ [THIS_RUN]: deployRun(THIS_RUN), 7: deployRun(7) }, [record(7, 'web')]);
    assert.equal(await find(stub), null);
  });

  test('never trusts a record of another workflow, whatever its name', async () => {
    // Any workflow can upload an artifact of that name, on any branch.
    const stub = api({ [THIS_RUN]: deployRun(THIS_RUN), 7: deployRun(7, { workflow_id: 202 }) }, [
      record(7),
    ]);
    assert.equal(await find(stub), null);
  });

  test("never trusts a run of this workflow's file from a commit that is not on main", async () => {
    // An edited deploy.yml dispatched from a branch is the same workflow, with
    // unreviewed code.
    const stub = api(
      { [THIS_RUN]: deployRun(THIS_RUN), 7: deployRun(7, { head_sha: OFF_MAIN }), 5: deployRun(5) },
      [record(7), record(5)],
    );
    assert.equal(await find(stub), 5);
  });

  test("never trusts a run from a fork's repository", async () => {
    const stub = api(
      {
        [THIS_RUN]: deployRun(THIS_RUN),
        7: deployRun(7, { head_repository: { full_name: 'mallory/app' } }),
      },
      [record(7)],
    );
    assert.equal(await find(stub), null);
  });

  test('skips expired records, and this run its own', async () => {
    const stub = api({ [THIS_RUN]: deployRun(THIS_RUN), 7: deployRun(7) }, [
      record(THIS_RUN),
      record(7, 'api', { expired: true }),
    ]);
    assert.equal(await find(stub), null);
  });

  test('fails when GitHub cannot be asked, instead of building again silently', async () => {
    const stub = api({}, [record(7)]);
    await assert.rejects(find(stub), /404/);
  });

  test('refuses a malformed commit or image name before asking anything', async () => {
    const stub = api({ [THIS_RUN]: deployRun(THIS_RUN) }, []);
    await assert.rejects(
      findRecord({
        repository: REPO,
        runId: THIS_RUN,
        sha: 'main',
        image: 'api',
        request: stub.request,
        isOnMain,
      }),
      /commit SHA/,
    );
    await assert.rejects(find(stub, 'api&name=x'), /image name/);
    assert.deepEqual(stub.paths, []);
  });
});

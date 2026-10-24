// Tests of deploy/vps/deploy.sh and rollback.sh (`node --test
// scripts/deploy-vps.test.mjs`): the real scripts, run with sh in a copy of
// the server's directory, against a stand-in for the Docker CLI that records
// every call and keeps what "runs" in a file. What they prove: the order
// (pull, data services, migrate, roll out), the database on the server or
// managed, the release pointers, the way back after a failed migration or
// rollout, readiness after a rollback, and one deployment or rollback at a
// time on a server.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const VPS = fileURLToPath(new URL('../deploy/vps/', import.meta.url));

/** A POSIX sh: on PATH, or on Windows the one Git ships (the hooks run with it). */
function findShell() {
  if (spawnSync('sh', ['-c', 'exit 0']).status === 0) return 'sh';
  const gitExec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const gitSh = join(gitExec, '..', '..', '..', 'bin', 'sh.exe');
  if (gitExec !== '' && existsSync(gitSh)) return gitSh;
  throw new Error('No POSIX sh found: install one (Git for Windows ships it) to run this test.');
}
const SH = findShell();

// The scripts run on the Linux server (Ubuntu: dash and util-linux); they
// need flock, which Git for Windows' sh does not ship. CI runs these tests on
// Linux.
const SKIP =
  spawnSync(SH, ['-c', 'command -v flock && command -v cmp']).status === 0
    ? false
    : 'needs flock and cmp (Linux); CI runs it';

// The Docker CLI as the scripts use it. Each call is a line in docker.log;
// "running" holds the api and web images that run; images listed in
// failing-images break their migration or their rollout, those in not-ready
// start but never answer readiness; failing-data stops the data services from
// starting. `config --services` lists PostgreSQL and its backup when an env
// file sets COMPOSE_PROFILES=db. FAKE_SECONDS slows migrate and up down.
const FAKE_DOCKER = `#!/bin/sh
log="$FAKE_DIR/docker.log"
case "$1" in
  login | logout) echo "$1" >> "$log"; exit 0 ;;
  compose) shift ;;
  *) echo "unexpected: docker $*" >&2; exit 64 ;;
esac
files=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) files="$files $2"; shift 2 ;;
    --profile) shift 2 ;;
    *) break ;;
  esac
done
for f in $files; do
  [ -f "$f" ] || { echo "couldn't find env file: $f" >&2; exit 1; }
done
value() {
  v=""
  for f in $files; do
    line=$(grep "^$1=" "$f" | tail -n 1)
    [ -n "$line" ] && v=\${line#*=}
  done
  printf '%s' "$v"
}
listed() { [ -f "$FAKE_DIR/$1" ] && grep -qxF "$2" "$FAKE_DIR/$1"; }
command=$1
shift
services=""
for argument in "$@"; do
  case "$argument" in
    -*) ;;
    *[!a-z]*) ;;
    *) services="$services $argument" ;;
  esac
done
data=false
case " $services " in *" redis "* | *" db "* | *" backup "*) data=true ;; esac
case "$command" in
  config)
    echo "proxy"; echo "api"; echo "web"; echo "redis"
    case ",$(value COMPOSE_PROFILES)," in *,db,*) echo "db"; echo "backup" ;; esac ;;
  pull)
    if $data; then
      echo "pull data$services" >> "$log"
    else
      echo "pull $(value API_IMAGE)" >> "$log"
      [ ! -f "$FAKE_DIR/failing-pull" ]
    fi ;;
  run)
    image=$(value MIGRATE_IMAGE)
    echo "migrate $image" >> "$log"
    sleep "\${FAKE_SECONDS:-0}"
    ! listed failing-images "$image" ;;
  up)
    if $data; then
      echo "up data$services" >> "$log"
      [ ! -f "$FAKE_DIR/failing-data" ]
      exit
    fi
    api=$(value API_IMAGE)
    echo "up $api $(value APP_RELEASE)" >> "$log"
    sleep "\${FAKE_SECONDS:-0}"
    echo "$api" > "$FAKE_DIR/running"
    ! listed failing-images "$api" ;;
  exec)
    ! listed not-ready "$(cat "$FAKE_DIR/running")" ;;
  logs) exit 0 ;;
  *) echo "unexpected: docker compose $command" >&2; exit 64 ;;
esac
`;

/** An image reference pinned by digest, one per image and release. */
const ref = (/** @type {string} */ image, /** @type {string} */ release) =>
  `ghcr.io/acme/app/${image}@sha256:${release.repeat(64).slice(0, 64)}`;

/**
 * The arguments of deploy.sh for a release: its api, api-migrate and web
 * images, and its name.
 * @param {string} name
 * @returns {[string, string, string, string]}
 */
const release = (name) => [
  ref('api', name),
  ref('api-migrate', name),
  ref('web', name),
  name.repeat(40).slice(0, 40),
];

const roots = /** @type {string[]} */ ([]);
let root = '';
let srv = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deploy-vps-'));
  roots.push(root);
  srv = join(root, 'srv');
  mkdirSync(srv);
  mkdirSync(join(root, 'bin'));
  for (const file of ['deploy.sh', 'rollback.sh']) copyFileSync(join(VPS, file), join(srv, file));
  for (const file of ['server.env', 'api.env', 'migrate.env', 'web.env', 'redis.env']) {
    writeFileSync(join(srv, file), '');
  }
  writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER);
  chmodSync(join(root, 'bin', 'docker'), 0o755);
});

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** @param {Record<string, string>} [env] */
function environment(env = {}) {
  return {
    PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
    FAKE_DIR: root,
    ...env,
  };
}

/**
 * Runs a script of the server's directory and waits for it.
 * @param {string} script
 * @param {string[]} [args]
 * @param {Record<string, string>} [env]
 */
function run(script, args = [], env = {}) {
  const result = spawnSync(SH, [join(srv, script), ...args], {
    encoding: 'utf8',
    env: environment(env),
  });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Starts a script without waiting for it.
 * @param {string} script
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ status: number | null; stdout: string; stderr: string }>}
 */
function start(script, args, env = {}) {
  const child = spawn(SH, [join(srv, script), ...args], { env: environment(env) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  return new Promise((resolve) => {
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

/**
 * Resolves once docker.log has a line starting with `prefix`, among the lines
 * after the first `from` ones: a script started after earlier runs logged the
 * same line waits for its own.
 */
async function logged(/** @type {string} */ prefix, from = 0) {
  for (let i = 0; i < 200; i++) {
    if (
      calls()
        .slice(from)
        .some((line) => line.startsWith(prefix))
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`never logged: ${prefix}`);
}

const calls = () =>
  existsSync(join(root, 'docker.log'))
    ? readFileSync(join(root, 'docker.log'), 'utf8').trim().split('\n')
    : [];
const running = () => readFileSync(join(root, 'running'), 'utf8').trim();
const pointer = (/** @type {string} */ file) =>
  existsSync(join(srv, file))
    ? (/^APP_RELEASE=(.*)$/m.exec(readFileSync(join(srv, file), 'utf8'))?.[1] ?? '')
    : null;
const list = (/** @type {string} */ file, /** @type {string[]} */ images) => {
  writeFileSync(join(root, file), `${images.join('\n')}\n`);
};

const A = release('a');
const B = release('b');

describe('deploy.sh', { skip: SKIP }, () => {
  test('first deployment: pulls, starts Redis, migrates, then rolls out, and records the release', () => {
    const result = run('deploy.sh', A);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(), [
      `pull ${A[0]}`,
      'pull data redis',
      'up data redis',
      `migrate ${A[1]}`,
      `up ${A[0]} ${A[3]}`,
    ]);
    assert.equal(running(), A[0]);
    assert.equal(pointer('release.env'), A[3]);
    assert.equal(pointer('release.previous.env'), null);
    assert.equal(pointer('release.next.env'), null);
  });

  test('a second release: the first becomes the rollback target', () => {
    run('deploy.sh', A);
    assert.equal(run('deploy.sh', B).status, 0);
    assert.equal(running(), B[0]);
    assert.equal(pointer('release.env'), B[3]);
    assert.equal(pointer('release.previous.env'), A[3]);
  });

  test('redeploying the running release keeps the rollback target, and says it redeployed', () => {
    run('deploy.sh', A);
    run('deploy.sh', B);
    assert.equal(existsSync(join(srv, 'release.redeployed')), false);
    assert.equal(run('deploy.sh', B).status, 0);
    assert.equal(pointer('release.env'), B[3]);
    assert.equal(pointer('release.previous.env'), A[3]);
    assert.equal(existsSync(join(srv, 'release.redeployed')), true);
    // The next release that changes something clears it.
    assert.equal(run('deploy.sh', A).status, 0);
    assert.equal(pointer('release.previous.env'), B[3]);
    assert.equal(existsSync(join(srv, 'release.redeployed')), false);
  });

  test('a failed migration stops before the rollout: the running release keeps serving', () => {
    run('deploy.sh', A);
    list('failing-images', [B[1]]);
    const result = run('deploy.sh', B);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the migration failed; the running release keeps serving/);
    assert.deepEqual(calls().slice(-4), [
      `pull ${B[0]}`,
      'pull data redis',
      'up data redis',
      `migrate ${B[1]}`,
    ]);
    assert.equal(running(), A[0]);
    assert.equal(pointer('release.env'), A[3]);
    // Nothing of the failed release stays behind for a later command to pick up.
    assert.equal(pointer('release.next.env'), null);
  });

  test('a failed rollout puts the release that was running back', () => {
    run('deploy.sh', A);
    list('failing-images', [B[0]]);
    const result = run('deploy.sh', B);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /back to the release that was running/);
    assert.deepEqual(calls().slice(-2), [`up ${B[0]} ${B[3]}`, `up ${A[0]} ${A[3]}`]);
    assert.equal(running(), A[0]);
    assert.equal(pointer('release.env'), A[3]);
    assert.equal(pointer('release.next.env'), null);
  });

  test('a rollout that fails when the release before it does not come back ready says so', () => {
    run('deploy.sh', A);
    list('failing-images', [B[0]]);
    list('not-ready', [A[0]]);
    const result = run('deploy.sh', B);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /back to the release that was running\n/);
    assert.match(result.stderr, /did not come back ready/);
    assert.equal(running(), A[0]);
  });

  test('a release whose API never gets ready is not recorded', () => {
    run('deploy.sh', A);
    list('not-ready', [B[0]]);
    const result = run('deploy.sh', B);
    assert.equal(result.status, 1);
    assert.equal(running(), A[0]);
    assert.equal(pointer('release.env'), A[3]);
  });

  test('with the database on the server: PostgreSQL and its backup start with Redis, before the migration', () => {
    writeFileSync(join(srv, 'server.env'), 'APP_DOMAIN=app.example.com\nCOMPOSE_PROFILES=db\n');
    for (const file of ['db.env', 'backup.env']) writeFileSync(join(srv, file), '');
    const result = run('deploy.sh', A);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(), [
      `pull ${A[0]}`,
      'pull data redis db backup',
      'up data redis db',
      'up data backup',
      `migrate ${A[1]}`,
      `up ${A[0]} ${A[3]}`,
    ]);
  });

  test('with the database on the server, refuses to deploy without its settings files', () => {
    writeFileSync(join(srv, 'server.env'), 'COMPOSE_PROFILES=db\n');
    writeFileSync(join(srv, 'db.env'), '');
    const result = run('deploy.sh', A);
    assert.equal(result.status, 2);
    assert.match(
      result.stderr,
      /backup\.env is missing next to compose\.yaml \(COMPOSE_PROFILES=db/,
    );
    assert.deepEqual(calls(), []);
    assert.equal(pointer('release.next.env'), null);
  });

  test('data services that do not start stop the deployment before the migration', () => {
    run('deploy.sh', A);
    writeFileSync(join(root, 'failing-data'), '');
    const result = run('deploy.sh', B);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /the data services did not start; the running release keeps serving/,
    );
    assert.deepEqual(calls().slice(-1), ['up data redis']);
    assert.equal(running(), A[0]);
    assert.equal(pointer('release.env'), A[3]);
    assert.equal(pointer('release.next.env'), null);
  });

  test('refuses an image not pinned by digest, and a missing settings file', () => {
    const tagged = run('deploy.sh', ['ghcr.io/acme/app/api:1.0', A[1], A[2], A[3]]);
    assert.equal(tagged.status, 2);
    assert.match(tagged.stderr, /not pinned by digest/);
    rmSync(join(srv, 'migrate.env'));
    const missing = run('deploy.sh', A);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /migrate\.env is missing/);
    writeFileSync(join(srv, 'migrate.env'), '');
    rmSync(join(srv, 'redis.env'));
    const noRedis = run('deploy.sh', A);
    assert.equal(noRedis.status, 2);
    assert.match(noRedis.stderr, /redis\.env is missing/);
    assert.deepEqual(calls(), []);
  });

  test('logs in for the pull only, and logs out even when the pull fails', () => {
    assert.equal(run('deploy.sh', A, { REGISTRY_TOKEN: 'synthetic' }).status, 0);
    assert.deepEqual(calls().slice(0, 4), ['login', `pull ${A[0]}`, 'pull data redis', 'logout']);
    // A pull refused (a digest the registry's content does not match, a
    // registry down) changes nothing on the server.
    writeFileSync(join(root, 'failing-pull'), '');
    const refused = run('deploy.sh', B, { REGISTRY_TOKEN: 'synthetic' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /could not pull release/);
    assert.deepEqual(calls().slice(-3), ['login', `pull ${B[0]}`, 'logout']);
    assert.equal(pointer('release.env'), A[3]);
    assert.equal(pointer('release.next.env'), null);
  });

  test('one at a time: a second deploy.sh while one runs is refused and changes nothing', async () => {
    run('deploy.sh', A);
    const first = start('deploy.sh', B, { FAKE_SECONDS: '1' });
    await logged(`pull ${B[0]}`);
    const second = await start('deploy.sh', A);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /another deployment or rollback is running/);
    const done = await first;
    assert.equal(done.status, 0, done.stderr);
    assert.equal(running(), B[0]);
    assert.equal(pointer('release.env'), B[3]);
    assert.equal(pointer('release.previous.env'), A[3]);
    // Only the first deployment of A pulled it: the refused run did nothing.
    assert.equal(calls().filter((line) => line === `pull ${A[0]}`).length, 1);
  });
});

describe('rollback.sh', { skip: SKIP }, () => {
  test('puts the previous release back', () => {
    run('deploy.sh', A);
    run('deploy.sh', B);
    const result = run('rollback.sh');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`rollback: running ${A[3]}`));
    assert.equal(running(), A[0]);
    assert.equal(pointer('release.env'), A[3]);
    assert.equal(pointer('release.failed.env'), B[3]);
  });

  test('starts the data services first, or leaves them running', () => {
    run('deploy.sh', A);
    run('deploy.sh', B);
    const before = calls().length;
    const result = run('rollback.sh');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls().slice(before), ['up data redis', `up ${A[0]} ${A[3]}`]);
  });

  test('with the database on the server: PostgreSQL and its backup too', () => {
    writeFileSync(join(srv, 'server.env'), 'APP_DOMAIN=app.example.com\nCOMPOSE_PROFILES=db\n');
    for (const file of ['db.env', 'backup.env']) writeFileSync(join(srv, file), '');
    run('deploy.sh', A);
    run('deploy.sh', B);
    const before = calls().length;
    const result = run('rollback.sh');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls().slice(before), [
      'up data redis db',
      'up data backup',
      `up ${A[0]} ${A[3]}`,
    ]);
  });

  test('data services that do not start stop it before the release changes', () => {
    run('deploy.sh', A);
    run('deploy.sh', B);
    writeFileSync(join(root, 'failing-data'), '');
    const result = run('rollback.sh');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rollback: the data services did not start/);
    assert.equal(running(), B[0]);
    assert.equal(pointer('release.env'), B[3]);
    assert.equal(pointer('release.previous.env'), A[3]);
  });

  test('after a redeployment of the running release, refuses to start the older one before it', () => {
    run('deploy.sh', A);
    run('deploy.sh', B);
    run('deploy.sh', B);
    const before = calls().length;
    const result = run('rollback.sh');
    assert.equal(result.status, 2);
    assert.match(
      result.stderr,
      new RegExp(
        `last successful deployment redeployed release ${B[3]}.*--previous starts release ${A[3]}`,
      ),
    );
    assert.deepEqual(calls().slice(before), []);
    assert.equal(running(), B[0]);
    assert.equal(pointer('release.env'), B[3]);
  });

  test('with --previous, starts the release before a redeployed one', () => {
    run('deploy.sh', A);
    run('deploy.sh', B);
    run('deploy.sh', B);
    const result = run('rollback.sh', ['--previous']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(running(), A[0]);
    assert.equal(pointer('release.env'), A[3]);
    assert.equal(existsSync(join(srv, 'release.redeployed')), false);
  });

  test('refuses when no previous release is recorded', () => {
    run('deploy.sh', A);
    const result = run('rollback.sh');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no previous release recorded/);
    assert.equal(running(), A[0]);
  });

  test('fails when the release it put back is not ready', () => {
    run('deploy.sh', A);
    run('deploy.sh', B);
    list('not-ready', [A[0]]);
    const result = run('rollback.sh');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not ready/);
    // It does run: the pointers say so.
    assert.equal(running(), A[0]);
    assert.equal(pointer('release.env'), A[3]);
  });

  test('is refused while a deployment runs', async () => {
    run('deploy.sh', A);
    run('deploy.sh', B);
    // The first deployment of A logged the same pull: wait for this one's,
    // made once it holds the lock.
    const before = calls().length;
    const deployment = start('deploy.sh', A, { FAKE_SECONDS: '1' });
    await logged(`pull ${A[0]}`, before);
    const rollback = run('rollback.sh');
    assert.equal(rollback.status, 1);
    assert.match(rollback.stderr, /another deployment or rollback is running/);
    assert.equal((await deployment).status, 0);
    assert.equal(running(), A[0]);
    assert.equal(pointer('release.env'), A[3]);
    assert.equal(pointer('release.previous.env'), B[3]);
  });

  test('says a deployment is running, rather than read a previous release it may be writing', async () => {
    // The first deployment: no previous release yet, until it finishes.
    const before = calls().length;
    const deployment = start('deploy.sh', A, { FAKE_SECONDS: '1' });
    await logged(`pull ${A[0]}`, before);
    const rollback = run('rollback.sh');
    assert.equal(rollback.status, 1);
    assert.match(rollback.stderr, /another deployment or rollback is running/);
    assert.doesNotMatch(rollback.stderr, /no previous release recorded/);
    assert.equal((await deployment).status, 0);
  });

  test('says a deployment is running, rather than read a redeployment it may be changing', async () => {
    run('deploy.sh', A);
    run('deploy.sh', B);
    run('deploy.sh', B);
    const before = calls().length;
    const deployment = start('deploy.sh', A, { FAKE_SECONDS: '1' });
    await logged(`pull ${A[0]}`, before);
    const rollback = run('rollback.sh');
    assert.equal(rollback.status, 1);
    assert.match(rollback.stderr, /another deployment or rollback is running/);
    assert.equal((await deployment).status, 0);
  });
});

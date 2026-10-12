// `pnpm iac:check` and the CI job "Infrastructure as code (Terraform)": the
// checks of infra/terraform (docs/ci-cd.md#infrastructure-as-code). Needs
// Docker; every tool is a pinned image of .github/tool-images/Dockerfile, and
// the repository is mounted read-only. Nothing is created in any cloud and no
// token is used. Any finding fails.
//
//   1. Terraform: fmt -check (every module), init without a backend and with
//      the lock file read-only (its checksums must match), validate, the
//      tests of tests/*.tftest.hcl (provider mocked), then the server's user
//      data rendered from tests/fixture.tfvars;
//   2. TFLint, all the bundled Terraform rules (infra/terraform/.tflint.hcl);
//   3. Trivy's misconfiguration checks: HIGH and CRITICAL fail; exceptions are
//      inline `trivy:ignore` comments with their reason;
//   4. the rendered user data against the schema of Ubuntu 24.04's cloud-init,
//      its runcmd script through shellcheck, and Docker's apt key by
//      fingerprint;
//   5. database/roles.sql on PostgreSQL, as an administrator that is not a
//      superuser (DigitalOcean's doadmin), twice, then the roles it leaves.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolesScript } from './iac-database.mjs';
import { ensureImage, pullableImage, toolImage } from './tool-image.mjs';

const INFRA = fileURLToPath(new URL('../infra/terraform', import.meta.url));

// Docker's release key, as docs.docker.com publishes it: the one apt may
// trust for Docker's repository (cloud-init.yaml.tftpl).
const DOCKER_KEY_FINGERPRINT = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88';

// The scripts the containers run and what they hand each other. Readable by
// every user: some images run as one of their own (actionlint as guest), and
// on Linux mkdtemp's 0700 would lock them out. It holds synthetic values only.
const work = mkdtempSync(join(tmpdir(), 'iac-check-'));
chmodSync(work, 0o755);

/**
 * Runs `script` (POSIX sh) in the pinned image `tool` (through the mirror
 * of TOOL_IMAGE_MIRROR when it is a Docker Hub or ECR Public image, as
 * runTool does), with
 * infra/terraform at /src (read-only) and the work directory at /out; returns
 * the exit status.
 * @param {string} tool a stage name of .github/tool-images/Dockerfile
 * @param {string} script
 * @param {Record<string, string>} [env]
 */
function inContainer(tool, script, env = {}) {
  const name = `${randomBytes(4).toString('hex')}.sh`;
  writeFileSync(join(work, name), script);
  const image = pullableImage(toolImage(tool));
  ensureImage(image);
  const run = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${INFRA}:/src:ro`,
      '-v',
      `${work}:/out`,
      ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      '--entrypoint',
      'sh',
      image,
      `/out/${name}`,
    ],
    { stdio: 'inherit' },
  );
  if (run.error) {
    console.error(
      `Could not start Docker (${run.error.message}). These checks need Docker; CI runs them on every pull request.`,
    );
    return 1;
  }
  return run.status ?? 1;
}

/** @type {{ step: string; status: number | 'skipped' }[]} */
const results = [];

/**
 * @param {string} step
 * @param {() => number} run
 */
function check(step, run) {
  console.log(`\n=== ${step}`);
  results.push({ step, status: run() });
}

try {
  check('Terraform: fmt, init, validate, test, user data', () =>
    inContainer(
      'terraform',
      `set -u
status=0
echo '--- terraform fmt -check -recursive'
terraform fmt -check -recursive -diff /src || status=1
cd /src/digitalocean
echo '--- terraform init (no backend, lock file read-only)'
terraform init -backend=false -input=false -lockfile=readonly || exit 1
echo '--- terraform validate'
terraform validate || exit 1
echo '--- terraform test'
terraform test -var-file=tests/fixture.tfvars || status=1
echo '--- user data, rendered from tests/fixture.tfvars'
echo 'base64encode(local.user_data)' | terraform console -var-file=tests/fixture.tfvars > /out/user-data.b64 || status=1
exit "$status"
`,
      // Plugins and the workspace stay in the container: nothing is written
      // next to the configuration.
      { TF_DATA_DIR: '/tmp/terraform', TF_IN_AUTOMATION: '1', CHECKPOINT_DISABLE: '1' },
    ),
  );

  check('TFLint', () =>
    inContainer(
      'tflint',
      'cd /src && exec tflint --recursive --config /src/.tflint.hcl --minimum-failure-severity=notice\n',
    ),
  );

  check('Trivy: misconfigurations, HIGH and CRITICAL', () =>
    inContainer(
      'trivy',
      // The checks bundled with the pinned image (Trivy logs that it falls
      // back to them): the same image gives the same result, and Dependabot
      // brings newer checks with each update. The tests' variables let it
      // evaluate every expression.
      'exec trivy config --skip-check-update --exit-code 1 --severity HIGH,CRITICAL --tf-vars /src/digitalocean/tests/fixture.tfvars /src\n',
    ),
  );

  const rendered = join(work, 'user-data.b64');
  if (existsSync(rendered) && readFileSync(rendered, 'utf8').trim().startsWith('"')) {
    const base64 = /** @type {string} */ (JSON.parse(readFileSync(rendered, 'utf8').trim()));
    writeFileSync(join(work, 'user-data.yaml'), Buffer.from(base64, 'base64'));

    check("cloud-init: schema, Docker's apt key, runcmd extracted", () =>
      inContainer(
        'ubuntu',
        `set -eu
export DEBIAN_FRONTEND=noninteractive
echo '--- installing cloud-init from the Ubuntu archive'
apt-get update -qq
apt-get install -y -qq --no-install-recommends cloud-init gnupg > /dev/null
echo "--- cloud-init schema ($(cloud-init --version 2>&1))"
cloud-init schema --config-file /out/user-data.yaml --annotate
echo '--- files/docker.asc'
# Every primary key in the file, not just the first: apt trusts them all
# for Docker's repository, so the file must hold Docker's key and no other.
fingerprint=$(GNUPGHOME=$(mktemp -d) gpg --batch --show-keys --with-colons /src/digitalocean/files/docker.asc | awk -F: '$1 == "pub" { primary = 1; next } $1 == "fpr" && primary { print $10; primary = 0 } $1 == "sub" { primary = 0 }')
if [ "$fingerprint" != "$EXPECTED_FINGERPRINT" ]; then
  echo "files/docker.asc must hold Docker's key ($EXPECTED_FINGERPRINT) and nothing else; it holds:" $fingerprint >&2
  exit 1
fi
echo "Docker's release key, $fingerprint"
python3 - <<'PYTHON'
import yaml
with open('/out/user-data.yaml') as source:
    commands = yaml.safe_load(source)['runcmd']
if not all(isinstance(command, str) for command in commands):
    raise SystemExit('runcmd: write each command as a string, so shellcheck sees what runs')
with open('/out/runcmd.sh', 'w') as script:
    script.write('#!/bin/sh\\n' + '\\n'.join(commands) + '\\n')
PYTHON
`,
        { EXPECTED_FINGERPRINT: DOCKER_KEY_FINGERPRINT },
      ),
    );

    check('shellcheck: the runcmd script', () =>
      existsSync(join(work, 'runcmd.sh'))
        ? inContainer('actionlint', 'exec shellcheck /out/runcmd.sh\n')
        : 1,
    );
  } else {
    results.push({ step: 'cloud-init and shellcheck (no rendered user data)', status: 'skipped' });
  }

  const passwords = {
    ADMIN_PASSWORD: randomBytes(24).toString('hex'),
    MIGRATOR_PASSWORD: randomBytes(24).toString('hex'),
    RUNTIME_PASSWORD: randomBytes(24).toString('hex'),
  };
  writeFileSync(
    join(work, 'roles.psql'),
    rolesScript({
      migratorPassword: passwords.MIGRATOR_PASSWORD,
      runtimePassword: passwords.RUNTIME_PASSWORD,
    }),
  );
  check('database/roles.sql on PostgreSQL', () =>
    inContainer(
      'postgres',
      `set -eu
# Passwords are checked over TCP (scram-sha-256); the socket, used to set up
# the administrator, trusts the container's own users.
docker-entrypoint.sh postgres > /tmp/postgres.log 2>&1 &
tries=0
until pg_isready -q -h 127.0.0.1 -U postgres; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then cat /tmp/postgres.log >&2; exit 1; fi
  sleep 1
done
# DigitalOcean's doadmin: Create role, Create DB, Replication, Bypass RLS; no superuser.
psql -X -q -v ON_ERROR_STOP=1 -U postgres \\
  -c "CREATE ROLE doadmin LOGIN CREATEROLE CREATEDB REPLICATION BYPASSRLS PASSWORD '$ADMIN_PASSWORD'" \\
  -c "CREATE DATABASE defaultdb OWNER doadmin"
export PGHOST=127.0.0.1
psql_as() { role=$1 password=$2 database=$3; shift 3; PGPASSWORD=$password psql -X -q -tA -v ON_ERROR_STOP=1 -U "$role" -d "$database" "$@"; }
echo '--- roles.sql as doadmin, twice (running it again must work)'
psql_as doadmin "$ADMIN_PASSWORD" defaultdb < /out/roles.psql
psql_as doadmin "$ADMIN_PASSWORD" defaultdb < /out/roles.psql
echo '--- what it leaves'
fail() { echo "FAILED: $1" >&2; exit 1; }
[ "$(psql_as doadmin "$ADMIN_PASSWORD" app -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'app'")" = app_migrator ] || fail 'app is not owned by app_migrator'
[ "$(psql_as doadmin "$ADMIN_PASSWORD" app -c "SELECT rolconnlimit FROM pg_roles WHERE rolname = 'app_runtime'")" = 50 ] || fail 'app_runtime has no connection limit of 50'
[ "$(psql_as doadmin "$ADMIN_PASSWORD" app -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('app_migrator', 'app_runtime') AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AND rolcanlogin")" = 2 ] || fail 'a role has more than LOGIN'
if psql_as app_runtime wrong-password app -c 'SELECT 1' > /dev/null 2>&1; then fail 'a wrong password was accepted'; fi
psql_as app_migrator "$MIGRATOR_PASSWORD" app -c 'CREATE TABLE iac_check (id int PRIMARY KEY, note text)' || fail 'app_migrator cannot create a table'
psql_as app_runtime "$RUNTIME_PASSWORD" app -c "INSERT INTO iac_check VALUES (1, 'a')" -c "UPDATE iac_check SET note = 'b'" -c 'SELECT count(*) FROM iac_check' -c 'DELETE FROM iac_check' > /dev/null || fail 'app_runtime cannot read and write the tables app_migrator creates'
for statement in 'CREATE TABLE iac_other (id int)' 'ALTER TABLE iac_check ADD COLUMN extra int' 'DROP TABLE iac_check' 'TRUNCATE iac_check'; do
  if psql_as app_runtime "$RUNTIME_PASSWORD" app -c "$statement" > /dev/null 2>&1; then fail "app_runtime may run: $statement"; fi
done
echo 'app owned by app_migrator; app_runtime: data only, 50 connections; passwords checked over SCRAM'
`,
      {
        ...passwords,
        POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
        POSTGRES_INITDB_ARGS: '--auth-host=scram-sha-256 --auth-local=trust',
      },
    ),
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('\n=== Summary');
for (const { step, status } of results) {
  console.log(`${status === 0 ? 'ok     ' : status === 'skipped' ? 'skipped' : 'FAILED '} ${step}`);
}
process.exit(results.every(({ status }) => status === 0) ? 0 : 1);

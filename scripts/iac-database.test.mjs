// Tests of scripts/iac-database.mjs (`node --test scripts/iac-database.test.mjs`):
// the SCRAM-SHA-256 verifier against the exchange of RFC 7677, the psql input,
// and the refusal of outputs that would put something unexpected on the
// server's command line. PostgreSQL itself accepting the verifiers and the
// script is checked by `pnpm iac:check` (scripts/check-iac.mjs).
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import { connection, remoteCommand, rolesScript, scramSha256Verifier } from './iac-database.mjs';

describe('scramSha256Verifier', () => {
  // RFC 7677, section 3: user "user", password "pencil".
  const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
  const authMessage = [
    'n=user,r=rOprNGfwEbeRWgbNEkqO',
    'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096',
    'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0',
  ].join(',');
  const clientProof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
  const serverSignature = '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';

  const verifier = scramSha256Verifier('pencil', { salt, iterations: 4096 });
  const match = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(verifier);

  test("has PostgreSQL's format", () => {
    assert.ok(match, verifier);
    assert.equal(match[1], salt.toString('base64'));
  });

  test("its server key signs the RFC's exchange as the RFC's server did", () => {
    const serverKey = Buffer.from(match?.[3] ?? '', 'base64');
    assert.equal(
      createHmac('sha256', serverKey).update(authMessage).digest('base64'),
      serverSignature,
    );
  });

  test("its stored key accepts the RFC's client proof, as a server checks it", () => {
    const storedKey = Buffer.from(match?.[2] ?? '', 'base64');
    const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
    const clientKey = Buffer.from(
      clientProof.map((byte, index) => byte ^ (clientSignature[index] ?? 0)),
    );
    assert.deepEqual(createHash('sha256').update(clientKey).digest(), storedKey);
  });

  test('uses a new salt each time', () => {
    assert.notEqual(scramSha256Verifier('pencil'), scramSha256Verifier('pencil'));
  });

  test('refuses passwords it cannot hash as PostgreSQL would', () => {
    assert.throws(() => scramSha256Verifier('two words'));
    assert.throws(() => scramSha256Verifier('pässword'));
    assert.throws(() => scramSha256Verifier(''));
  });
});

describe('rolesScript', () => {
  test('sets both verifiers, then runs the script, and never contains the passwords', () => {
    const script = rolesScript({
      migratorPassword: 'MigratorPassword123',
      runtimePassword: 'RuntimePassword456',
      sql: 'SELECT 1;\n',
    });
    const lines = script.split('\n');
    assert.match(lines[0] ?? '', /^\\set migrator_password 'SCRAM-SHA-256\$4096:[^']+'$/);
    assert.match(lines[1] ?? '', /^\\set runtime_password 'SCRAM-SHA-256\$4096:[^']+'$/);
    assert.equal(lines.slice(2).join('\n'), 'SELECT 1;\n');
    assert.ok(!script.includes('MigratorPassword123'));
    assert.ok(!script.includes('RuntimePassword456'));
  });

  test('reads the committed roles.sql by default', () => {
    const script = rolesScript({ migratorPassword: 'a1', runtimePassword: 'b2' });
    assert.ok(script.includes("ALTER ROLE app_migrator WITH LOGIN PASSWORD :'migrator_password';"));
    assert.ok(script.includes('CREATE DATABASE app OWNER app_migrator'));
  });
});

/**
 * A connection string of the shape Terraform outputs, with a synthetic
 * password: assembled with the URL API, so the file holds no literal
 * credential for secretlint to flag.
 * @param {string} user
 * @param {string} password
 * @param {string} host
 * @param {string} database
 * @param {string} [query]
 */
function postgresUrl(user, password, host, database, query = '') {
  const url = new URL(`postgresql://${host}:25060/${database}${query}`);
  url.username = user;
  url.password = password;
  return url.href;
}

describe('connection', () => {
  const host = 'private-db.example.ondigitalocean.com';
  const tls = '?sslmode=require&uselibpqcompat=true';
  /** @param {Record<string, string>} [overrides] */
  const outputs = (overrides = {}) =>
    Object.fromEntries(
      Object.entries({
        ssh_admin: 'ops@192.0.2.10',
        database_admin_url: postgresUrl(
          'doadmin',
          'AVNS_admin/secret',
          host,
          'defaultdb',
          '?sslmode=require',
        ),
        database_migrator_url: postgresUrl('app_migrator', 'Migrator123', host, 'app', tls),
        database_runtime_url: postgresUrl('app_runtime', 'Runtime456', host, 'app', tls),
        ...overrides,
      }).map(([name, value]) => [name, { value }]),
    );

  test('reads the server, the administrator and both passwords', () => {
    assert.deepEqual(connection(outputs()), {
      ssh: 'ops@192.0.2.10',
      host: 'private-db.example.ondigitalocean.com',
      port: '25060',
      user: 'doadmin',
      database: 'defaultdb',
      adminPassword: 'AVNS_admin/secret',
      migratorPassword: 'Migrator123',
      runtimePassword: 'Runtime456',
    });
  });

  test('asks for terraform apply when an output is missing', () => {
    const { database_runtime_url: _, ...missing } = outputs();
    assert.throws(() => connection(missing), /No output "database_runtime_url"/);
  });

  test('refuses values that would change the remote command', () => {
    assert.throws(() => connection(outputs({ ssh_admin: 'ops@192.0.2.10;reboot' })), /ssh/);
    assert.throws(
      () =>
        connection(
          outputs({
            database_admin_url: "postgresql://doadmin:x@db';reboot;'.example:25060/defaultdb",
          }),
        ),
      /Invalid URL|host/,
    );
    assert.throws(
      () =>
        connection(
          outputs({ database_admin_url: 'postgresql://do$admin:x@db.example:25060/defaultdb' }),
        ),
      /user/,
    );
  });

  test('refuses an empty password', () => {
    assert.throws(
      () =>
        connection(
          outputs({ database_runtime_url: 'postgresql://app_runtime@db.example:25060/app' }),
        ),
      /runtimePassword/,
    );
  });
});

describe('remoteCommand', () => {
  test('passes the connection in the environment and no secret', () => {
    const settings = connection(
      Object.fromEntries(
        Object.entries({
          ssh_admin: 'ops@192.0.2.10',
          database_admin_url: postgresUrl('doadmin', 'AdminSecret', 'db.example', 'defaultdb'),
          database_migrator_url: postgresUrl('app_migrator', 'MigratorSecret', 'db.example', 'app'),
          database_runtime_url: postgresUrl('app_runtime', 'RuntimeSecret', 'db.example', 'app'),
        }).map(([name, value]) => [name, { value }]),
      ),
    );
    const command = remoteCommand(settings, 'postgres:18-alpine@sha256:abc');
    assert.equal(
      command,
      "sudo docker run --rm -i -e PGHOST=db.example -e PGPORT=25060 -e PGUSER=doadmin -e PGDATABASE=defaultdb -e PGSSLMODE=require postgres:18-alpine@sha256:abc sh -c 'IFS= read -r PGPASSWORD && export PGPASSWORD && exec psql -X -q -v ON_ERROR_STOP=1'",
    );
    for (const secret of ['AdminSecret', 'MigratorSecret', 'RuntimeSecret']) {
      assert.ok(!command.includes(secret));
    }
  });
});

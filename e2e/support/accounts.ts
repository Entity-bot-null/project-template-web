import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { API_DIR, e2eDatabaseUrl } from '../../apps/api/scripts/e2e-env.mjs';

export interface Account {
  email: string;
  name: string;
  password: string;
}

/**
 * A member account of the suite's database for one test, created as an
 * operator would (the built `user:create` CLI, whose password rules apply):
 * a test that changes its password never touches the seeded accounts other
 * tests sign in with, and a retry starts with a new address.
 */
export function createAccount(name: string, password = 'lantern harbour violet 41'): Account {
  const email = `e2e-${randomUUID()}@example.test`;
  execFileSync(
    process.execPath,
    ['dist/users/create-user.cli.js', '--email', email, '--name', name],
    {
      cwd: API_DIR,
      input: password,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DATABASE_URL: e2eDatabaseUrl().toString(),
        // The CLI loads the API's settings; it signs nothing and sends nothing.
        JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
        MAIL_SMTP_URL: '',
        MAIL_FROM: '',
        APP_ORIGIN: '',
        SIGN_UP_ENABLED: 'false',
      },
      stdio: ['pipe', 'ignore', 'inherit'],
    },
  );
  return { email, name, password };
}

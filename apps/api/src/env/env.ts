import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { type Env, EnvSchema } from './env.schema.js';

// Every variable the API reads is declared and validated in env.schema.ts and
// parsed here, once, at import time. The rest of the code imports `env` and
// never touches process.env (an ESLint rule enforces it): a missing or
// malformed value stops the boot with the variable's name instead of failing
// later at first use. Values are never printed, they may be secrets.
//
// A local .env is loaded first; variables already set in the environment win.
// Tests skip the file so a developer's settings never leak into them.
if (process.env.NODE_ENV !== 'test' && existsSync('.env')) {
  process.loadEnvFile('.env');
}

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  for (const issue of parsed.error.issues) {
    const name = issue.path.join('.') || '(environment)';
    Logger.error(`Environment variable ${name} is invalid: ${issue.message}`, 'Env');
  }
  process.exit(1);
}

export type { Env };
export const env: Env = parsed.data;

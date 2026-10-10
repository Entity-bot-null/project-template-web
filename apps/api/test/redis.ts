import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { RedisOptions } from '../src/infrastructure/redis/redis.types.js';

// Redis for the specs of the Redis-backed adapters (*.int.spec.ts in
// src/infrastructure). REDIS_TEST_URL (CI starts a throwaway Redis), else
// REDIS_URL from the local .env (docker compose --profile redis up -d). Every
// run writes under its own key prefix, so a development Redis is safe to use:
// the specs never touch other keys.
//
// No Redis: the specs are skipped locally (Redis is optional), but fail in CI,
// where skipping would hide a broken adapter.

function configuredUrl(): string | undefined {
  if (process.env.REDIS_TEST_URL !== undefined) return process.env.REDIS_TEST_URL;
  if (existsSync('.env')) return parseEnv(readFileSync('.env', 'utf8')).REDIS_URL;
  return undefined;
}

export const redisTestUrl = configuredUrl();

/** describe.skipIf(skipWithoutRedis) */
export const skipWithoutRedis = redisTestUrl === undefined && process.env.CI !== 'true';

/** A Redis no one listens on: connection refused at once. */
export const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:1';

/** RedisService options for a spec: a fresh key prefix per call. */
export function redisTestOptions(overrides: Partial<RedisOptions> = {}): RedisOptions {
  if (redisTestUrl === undefined) {
    throw new Error(
      'No Redis for the integration specs: set REDIS_TEST_URL, or REDIS_URL in apps/api/.env (docker compose --profile redis up -d).',
    );
  }
  return {
    url: redisTestUrl,
    keyPrefix: `it-${randomUUID().slice(0, 8)}:`,
    required: false,
    commandTimeoutMs: 1_000,
    production: false,
    ...overrides,
  };
}

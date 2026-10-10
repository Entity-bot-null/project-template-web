import { describe, expect, it } from 'vitest';
import { EnvSchema } from './env.schema.js';

const SECRET = 'a'.repeat(32) + 'b'.repeat(32);
const OTHER_SECRET = 'c'.repeat(64);

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://app@localhost:5432/app',
  JWT_ACCESS_SECRET: SECRET,
};
const production = { ...base, NODE_ENV: 'production', TRUST_PROXY: '1' };

function issuePaths(input: Record<string, string>): string[] {
  const result = EnvSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('EnvSchema', () => {
  it('applies the documented defaults outside production', () => {
    expect(EnvSchema.parse(base)).toMatchObject({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      CORS_ORIGINS: [],
      TRUST_PROXY: 'loopback',
      AUTH_COOKIE_SAMESITE: 'strict',
      RATE_LIMIT_MAX: 100,
      RATE_LIMIT_WINDOW_SEC: 60,
      LOG_LEVEL: 'log',
      LOG_FORMAT: 'text',
      APP_ENVIRONMENT: 'development',
      APP_RELEASE: 'unversioned',
      SENTRY_SAMPLE_RATE: 1,
      OTEL_SERVICE_NAME: 'api',
      OTEL_METRIC_EXPORT_INTERVAL: 60_000,
      DB_SLOW_QUERY_MS: 500,
      DB_POOL_MAX: 10,
      DB_STATEMENT_TIMEOUT_MS: 30_000,
      REDIS_KEY_PREFIX: 'app:',
      REDIS_REQUIRED: false,
      REDIS_COMMAND_TIMEOUT_MS: 500,
      RATE_LIMIT_STORE: 'memory',
      CACHE_STORE: 'memory',
    });
  });

  it('leaves every optional integration off by default: no account or server needed', () => {
    const parsed = EnvSchema.parse(base);
    expect(parsed.SENTRY_DSN).toBeUndefined();
    expect(parsed.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(parsed.REDIS_URL).toBeUndefined();
  });

  it('applies the production defaults: every interface (IPv4 and IPv6), JSON logs', () => {
    const parsed = EnvSchema.parse(production);
    expect(parsed).toMatchObject({ TRUST_PROXY: 1, LOG_FORMAT: 'json' });
    expect(parsed.HOST).toBeUndefined();
    expect(EnvSchema.parse({ ...production, HOST: '10.0.0.5' }).HOST).toBe('10.0.0.5');
  });

  it('requires NODE_ENV: an unset value must not fall back to development', () => {
    const { NODE_ENV: _, ...noEnv } = base;
    expect(issuePaths(noEnv)).toEqual(['NODE_ENV']);
    expect(issuePaths({ ...base, NODE_ENV: 'staging' })).toEqual(['NODE_ENV']);
  });

  it('requires a PostgreSQL URL and a generated token secret', () => {
    expect(issuePaths({ NODE_ENV: 'test' })).toEqual(['DATABASE_URL', 'JWT_ACCESS_SECRET']);
    expect(issuePaths({ ...base, DATABASE_URL: 'mysql://localhost/app' })).toEqual([
      'DATABASE_URL',
    ]);
    // A memorable phrase is crackable offline from any token it signed.
    expect(issuePaths({ ...base, JWT_ACCESS_SECRET: 'this-is-our-production-jwt-secret' })).toEqual(
      ['JWT_ACCESS_SECRET'],
    );
  });

  it('accepts a previous secret for rotation, different from the current one', () => {
    expect(EnvSchema.parse({ ...base, JWT_ACCESS_SECRET_PREVIOUS: OTHER_SECRET })).toMatchObject({
      JWT_ACCESS_SECRET_PREVIOUS: OTHER_SECRET,
    });
    expect(EnvSchema.parse({ ...base, JWT_ACCESS_SECRET_PREVIOUS: '' })).not.toHaveProperty(
      'JWT_ACCESS_SECRET_PREVIOUS',
      expect.anything(),
    );
    expect(issuePaths({ ...base, JWT_ACCESS_SECRET_PREVIOUS: SECRET })).toEqual([
      'JWT_ACCESS_SECRET_PREVIOUS',
    ]);
    expect(issuePaths({ ...base, JWT_ACCESS_SECRET_PREVIOUS: 'short' })).toEqual([
      'JWT_ACCESS_SECRET_PREVIOUS',
    ]);
  });

  it('requires TRUST_PROXY in production, where a wrong value lets clients pick their IP', () => {
    const { TRUST_PROXY: _, ...noTrust } = production;
    expect(issuePaths(noTrust)).toEqual(['TRUST_PROXY']);
    expect(EnvSchema.parse({ ...base, TRUST_PROXY: '10.0.0.0/8' }).TRUST_PROXY).toBe('10.0.0.0/8');
  });

  it('coerces numbers and rejects impossible ports', () => {
    expect(EnvSchema.parse({ ...base, PORT: '8080' }).PORT).toBe(8080);
    expect(issuePaths({ ...base, PORT: '70000' })).toEqual(['PORT']);
    expect(issuePaths({ ...base, RATE_LIMIT_MAX: '0' })).toEqual(['RATE_LIMIT_MAX']);
    expect(EnvSchema.parse({ ...base, DB_POOL_MAX: '25' }).DB_POOL_MAX).toBe(25);
    expect(issuePaths({ ...base, DB_POOL_MAX: '0' })).toEqual(['DB_POOL_MAX']);
    // No "off": a statement timeout of 0 would let a stuck query hold its
    // connection forever.
    expect(issuePaths({ ...base, DB_STATEMENT_TIMEOUT_MS: '0' })).toEqual([
      'DB_STATEMENT_TIMEOUT_MS',
    ]);
    expect(
      EnvSchema.parse({ ...base, DB_STATEMENT_TIMEOUT_MS: '120000' }).DB_STATEMENT_TIMEOUT_MS,
    ).toBe(120_000);
  });

  it('reads CORS_ORIGINS as a comma-separated list of bare origins', () => {
    expect(
      EnvSchema.parse({ ...base, CORS_ORIGINS: 'https://app.example.com, http://localhost:5173' })
        .CORS_ORIGINS,
    ).toEqual(['https://app.example.com', 'http://localhost:5173']);
    expect(issuePaths({ ...base, CORS_ORIGINS: 'https://app.example.com/' })).toEqual([
      'CORS_ORIGINS.0',
    ]);
    expect(issuePaths({ ...base, CORS_ORIGINS: 'ftp://files.example.com' })).toEqual([
      'CORS_ORIGINS.0',
    ]);
  });

  it('reads APP_ORIGIN as one bare origin, unset by default', () => {
    expect(EnvSchema.parse(base).APP_ORIGIN).toBeUndefined();
    expect(EnvSchema.parse({ ...base, APP_ORIGIN: 'https://app.example.com' }).APP_ORIGIN).toBe(
      'https://app.example.com',
    );
    expect(issuePaths({ ...base, APP_ORIGIN: 'https://app.example.com/login' })).toEqual([
      'APP_ORIGIN',
    ]);
  });

  it('allows SameSite=None only in production, where cookies are Secure', () => {
    expect(issuePaths({ ...base, AUTH_COOKIE_SAMESITE: 'none' })).toEqual(['AUTH_COOKIE_SAMESITE']);
    expect(issuePaths({ ...production, AUTH_COOKIE_SAMESITE: 'none' })).toEqual([]);
  });

  it('tells staging from production through APP_ENVIRONMENT, and checks the release name', () => {
    expect(EnvSchema.parse({ ...production, APP_ENVIRONMENT: 'staging' }).APP_ENVIRONMENT).toBe(
      'staging',
    );
    expect(EnvSchema.parse({ ...base, APP_RELEASE: '1.4.0+abc1234' }).APP_RELEASE).toBe(
      '1.4.0+abc1234',
    );
    expect(issuePaths({ ...base, APP_ENVIRONMENT: 'Prod Env' })).toEqual(['APP_ENVIRONMENT']);
    expect(issuePaths({ ...base, APP_RELEASE: 'v1 "quoted"' })).toEqual(['APP_RELEASE']);
  });

  it('refuses Redis-backed features without REDIS_URL, naming each one', () => {
    expect(
      issuePaths({
        ...base,
        RATE_LIMIT_STORE: 'redis',
        CACHE_STORE: 'redis',
        REDIS_REQUIRED: 'true',
      }),
    ).toEqual(['RATE_LIMIT_STORE', 'CACHE_STORE', 'REDIS_REQUIRED']);
    const withRedis = { ...base, REDIS_URL: 'rediss://:pw@cache.internal:6380' };
    expect(issuePaths({ ...withRedis, RATE_LIMIT_STORE: 'redis', REDIS_REQUIRED: 'true' })).toEqual(
      [],
    );
  });

  it('accepts redis:// and rediss:// URLs only', () => {
    expect(issuePaths({ ...base, REDIS_URL: 'redis://localhost:6379' })).toEqual([]);
    expect(issuePaths({ ...base, REDIS_URL: 'http://localhost:6379' })).toEqual(['REDIS_URL']);
    expect(issuePaths({ ...base, REDIS_KEY_PREFIX: 'app' })).toEqual(['REDIS_KEY_PREFIX']);
  });

  it('checks the Sentry DSN shape, and requires https for it in production', () => {
    const dsn = 'https://abc123@o1.ingest.example.com/42';
    expect(EnvSchema.parse({ ...production, SENTRY_DSN: dsn }).SENTRY_DSN).toBe(dsn);
    expect(issuePaths({ ...base, SENTRY_DSN: 'https://o1.ingest.example.com/42' })).toEqual([
      'SENTRY_DSN',
    ]);
    expect(issuePaths({ ...base, SENTRY_DSN: 'http://abc123@localhost:9000/1' })).toEqual([]);
    expect(issuePaths({ ...production, SENTRY_DSN: 'http://abc123@localhost:9000/1' })).toEqual([
      'SENTRY_DSN',
    ]);
  });

  it('validates the telemetry settings it relies on', () => {
    expect(
      EnvSchema.parse({
        ...base,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_SDK_DISABLED: 'true',
      }),
    ).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_SDK_DISABLED: true,
    });
    expect(issuePaths({ ...base, OTEL_TRACES_SAMPLER: 'sometimes' })).toEqual([
      'OTEL_TRACES_SAMPLER',
    ]);
    expect(issuePaths({ ...base, OTEL_TRACES_SAMPLER_ARG: '1.5' })).toEqual([
      'OTEL_TRACES_SAMPLER_ARG',
    ]);
    expect(issuePaths({ ...base, SENTRY_SAMPLE_RATE: '-0.1' })).toEqual(['SENTRY_SAMPLE_RATE']);
  });

  it('reads flags strictly: a typo is an error, not false', () => {
    expect(
      issuePaths({ ...base, REDIS_URL: 'redis://localhost:6379', REDIS_REQUIRED: 'yes' }),
    ).toEqual(['REDIS_REQUIRED']);
    expect(issuePaths({ ...base, OTEL_SDK_DISABLED: '1' })).toEqual(['OTEL_SDK_DISABLED']);
  });

  it('lets LOG_FORMAT override the default and rejects unknown levels', () => {
    expect(EnvSchema.parse({ ...production, LOG_FORMAT: 'text' }).LOG_FORMAT).toBe('text');
    expect(issuePaths({ ...base, LOG_LEVEL: 'chatty' })).toEqual(['LOG_LEVEL']);
  });

  it('reads an empty numeric value as unset (its default), never as 0', () => {
    const parsed = EnvSchema.parse({
      ...base,
      SENTRY_SAMPLE_RATE: '',
      DB_SLOW_QUERY_MS: '',
      PORT: '',
      REDIS_COMMAND_TIMEOUT_MS: '',
    });
    expect(parsed.SENTRY_SAMPLE_RATE).toBe(1);
    expect(parsed.DB_SLOW_QUERY_MS).toBe(500);
    expect(parsed.PORT).toBe(3000);
    expect(parsed.REDIS_COMMAND_TIMEOUT_MS).toBe(500);
    // An explicit 0 is still 0 where it is valid.
    expect(EnvSchema.parse({ ...base, SENTRY_SAMPLE_RATE: '0' }).SENTRY_SAMPLE_RATE).toBe(0);
  });
});

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
      MAIL_MAX_ATTEMPTS: 8,
      MAIL_DAILY_LIMIT_PER_ADDRESS: 10,
    });
  });

  it('leaves every optional integration off by default: no account or server needed', () => {
    const parsed = EnvSchema.parse(base);
    expect(parsed.SENTRY_DSN).toBeUndefined();
    expect(parsed.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(parsed.REDIS_URL).toBeUndefined();
    expect(parsed.MAIL_SMTP_URL).toBeUndefined();
    expect(parsed.MAIL_FROM).toBeUndefined();
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

  it('reads APP_BASE_PATH as the path of the web app, /app by default', () => {
    expect(EnvSchema.parse(base).APP_BASE_PATH).toBe('/app');
    expect(EnvSchema.parse({ ...base, APP_BASE_PATH: '' }).APP_BASE_PATH).toBe('/app');
    for (const path of ['/', '/portal', '/portal/v2', '/my-app_1.0~x']) {
      expect(EnvSchema.parse({ ...base, APP_BASE_PATH: path }).APP_BASE_PATH).toBe(path);
    }
    for (const path of [
      'app',
      '/app/',
      '//app',
      '/app//x',
      '/../x',
      '/./x',
      '/a b',
      '/app?x',
      '/app#x',
    ]) {
      expect(issuePaths({ ...base, APP_BASE_PATH: path }), path).toEqual(['APP_BASE_PATH']);
    }
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

  it('reports a malformed origin as invalid, never throws (the value would reach the log)', () => {
    expect(() => EnvSchema.safeParse({ ...base, APP_ORIGIN: 'not a url' })).not.toThrow();
    expect(issuePaths({ ...base, APP_ORIGIN: 'not a url' })).toEqual(['APP_ORIGIN']);
    // The second origin of the list, exactly.
    expect(issuePaths({ ...base, CORS_ORIGINS: 'https://ok.test,not a url' })).toEqual([
      'CORS_ORIGINS.1',
    ]);
    expect(issuePaths({ ...base, MAIL_SMTP_URL: 'not a url' })).toContain('MAIL_SMTP_URL');
  });

  describe('email', () => {
    const mail = {
      ...base,
      MAIL_SMTP_URL: 'smtp://localhost:1035',
      MAIL_FROM: 'Acme <no-reply@acme.test>',
      APP_ORIGIN: 'http://localhost:5173',
    };

    it('turns on with an SMTP URL, a sender and the public origin links point to', () => {
      expect(EnvSchema.parse(mail)).toMatchObject({
        MAIL_SMTP_URL: 'smtp://localhost:1035',
        MAIL_FROM: { name: 'Acme', address: 'no-reply@acme.test' },
      });
      expect(EnvSchema.parse({ ...mail, MAIL_FROM: 'no-reply@acme.test' }).MAIL_FROM).toEqual({
        address: 'no-reply@acme.test',
      });
      expect(
        EnvSchema.parse({ ...mail, MAIL_SMTP_URL: 'smtps://user:p%40ss@smtp.acme.test:465' })
          .MAIL_SMTP_URL,
      ).toBe('smtps://user:p%40ss@smtp.acme.test:465');
    });

    it('requires the sender and the public origin with an SMTP URL, and an SMTP URL with a sender', () => {
      const { MAIL_FROM: _from, APP_ORIGIN: _origin, ...urlOnly } = mail;
      expect(issuePaths(urlOnly).sort()).toEqual(['APP_ORIGIN', 'MAIL_FROM']);
      expect(issuePaths({ ...base, MAIL_FROM: 'no-reply@acme.test' })).toEqual(['MAIL_FROM']);
    });

    it('requires an https public origin in production: links carry one-time tokens', () => {
      const productionMail = { ...production, ...mail, NODE_ENV: 'production' };
      for (const origin of [
        'http://app.acme.test',
        'http://127.0.0.2:4173',
        'http://a.localhost',
      ]) {
        expect(issuePaths({ ...productionMail, APP_ORIGIN: origin }), origin).toEqual([
          'APP_ORIGIN',
        ]);
      }
      expect(issuePaths({ ...productionMail, APP_ORIGIN: 'https://app.acme.test' })).toEqual([]);
    });

    it('lets the production build run on one machine use an http loopback origin', () => {
      const productionMail = { ...production, ...mail, NODE_ENV: 'production' };
      for (const origin of [
        'http://localhost:4173',
        'http://127.0.0.1:4173',
        'http://[::1]:4173',
      ]) {
        expect(issuePaths({ ...productionMail, APP_ORIGIN: origin }), origin).toEqual([]);
      }
    });

    it('keeps public sign-up off by default, and allows it only with email', () => {
      expect(EnvSchema.parse(mail).SIGN_UP_ENABLED).toBe(false);
      expect(EnvSchema.parse({ ...mail, SIGN_UP_ENABLED: 'true' }).SIGN_UP_ENABLED).toBe(true);
      expect(issuePaths({ ...base, SIGN_UP_ENABLED: 'true' })).toEqual(['SIGN_UP_ENABLED']);
      expect(issuePaths({ ...base, SIGN_UP_ENABLED: 'yes' })).toEqual(['SIGN_UP_ENABLED']);
    });

    it('accepts only smtp:// or smtps:// with a host and nothing after it', () => {
      for (const value of [
        'http://smtp.acme.test',
        'smtp://',
        'smtp://smtp.acme.test/path',
        'smtp://smtp.acme.test?secure=false',
        'not a url',
      ]) {
        expect(issuePaths({ ...mail, MAIL_SMTP_URL: value }), value).toEqual(['MAIL_SMTP_URL']);
      }
    });

    it('refuses a sender that could inject a header or is not an address', () => {
      for (const value of [
        'Acme <no-reply@acme.test>\r\nBcc: victim@example.test',
        '"Acme" <no-reply@acme.test>',
        'Acme, Inc <no-reply@acme.test>',
        'Acme <not-an-address>',
        'no-reply',
        '<no-reply@acme.test>',
      ]) {
        expect(issuePaths({ ...mail, MAIL_FROM: value }), value).toEqual(['MAIL_FROM']);
      }
    });

    it('bounds the attempts and the per-address daily limit', () => {
      expect(issuePaths({ ...mail, MAIL_MAX_ATTEMPTS: '0' })).toEqual(['MAIL_MAX_ATTEMPTS']);
      expect(issuePaths({ ...mail, MAIL_MAX_ATTEMPTS: '51' })).toEqual(['MAIL_MAX_ATTEMPTS']);
      expect(issuePaths({ ...mail, MAIL_DAILY_LIMIT_PER_ADDRESS: '0' })).toEqual([
        'MAIL_DAILY_LIMIT_PER_ADDRESS',
      ]);
      expect(EnvSchema.parse({ ...mail, MAIL_DAILY_LIMIT_PER_ADDRESS: '3' })).toMatchObject({
        MAIL_DAILY_LIMIT_PER_ADDRESS: 3,
      });
    });
  });
});

import { z } from 'zod';

/** Nest log levels, most to least severe. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;

/** 32 random bytes as hex: what `openssl rand -hex 32` prints. */
export const MIN_SECRET_LENGTH = 64;

const origin = z
  .url({ protocol: /^https?$/ })
  .refine(
    (value) => new URL(value).origin === value,
    'must be an origin: scheme://host[:port], without path or trailing slash',
  );

// Comma-separated list; empty means none.
const originList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .pipe(z.array(origin));

// Express "trust proxy": a hop count, or addresses/subnets/names.
const trustProxy = z
  .string()
  .trim()
  .min(1)
  .transform((value) => (/^\d+$/.test(value) ? Number(value) : value));

// A signing secret long enough that it can only come from a generator: a
// human-chosen value can be brute-forced offline from any token it signed.
const signingSecret = z
  .string()
  .min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters: openssl rand -hex 32`);

// An empty value reads as unset (convenient in .env files and compose).
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

// The same for a variable with a default: empty means the default, never the
// 0 that z.coerce.number() would make of it (0 is valid for some of them).
const emptyAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

// "true" or "false", nothing else: a typo must not silently mean false.
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

const ratio = z.coerce.number().min(0).max(1);

const milliseconds = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

// Names that end up in log fields, metric attributes and URLs.
const label = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'lowercase letters, digits and "-", starting with a letter');

const redisUrl = z.url({ protocol: /^rediss?$/ });

// Every variable the API reads, with its type, default and rules. The schema
// lives apart from env.ts so it can be unit tested: env.ts parses
// process.env at import time and stops the process on failure.
export const EnvSchema = z
  .object({
    // No default: an unset NODE_ENV must stop the boot, not silently run a
    // production server with development settings (no Secure cookies, Swagger UI).
    NODE_ENV: z.enum(['development', 'test', 'production']),
    // Interface to listen on. Default: IPv4 loopback outside production (a
    // development API with public seed accounts never reaches the network);
    // unset in production, which listens on every interface, IPv4 and IPv6.
    HOST: optional(z.string().trim().min(1)),
    PORT: emptyAsUnset(z.coerce.number().int().min(1).max(65_535).default(3000)),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

    // Signs the short-lived access tokens. Refresh tokens are opaque random
    // values stored hashed in the database, so they need no secret.
    JWT_ACCESS_SECRET: signingSecret,
    // During a rotation, the other secret still accepted when verifying
    // (docs/security.md#secret-rotation). Never used to sign.
    JWT_ACCESS_SECRET_PREVIOUS: optional(signingSecret),

    // Browser origins allowed to call the API cross-origin with credentials.
    // Empty (default): no CORS headers at all, same-origin only.
    CORS_ORIGINS: originList,
    // Which proxy hops may set X-Forwarded-For (client IP for rate limits and
    // logs). Required in production, where the right value depends on the
    // topology and a wrong one lets clients choose their own IP; loopback
    // only elsewhere.
    TRUST_PROXY: optional(trustProxy),
    AUTH_COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),

    // Per client IP and per route, fixed window (sign-in and refresh have
    // tighter limits of their own).
    RATE_LIMIT_MAX: emptyAsUnset(z.coerce.number().int().positive().default(100)),
    RATE_LIMIT_WINDOW_SEC: emptyAsUnset(z.coerce.number().int().positive().default(60)),

    LOG_LEVEL: z.enum(LOG_LEVELS).default('log'),
    LOG_FORMAT: z.enum(['json', 'text']).optional(),

    // --- Deployment identity (docs/observability.md#identity) -------------
    // Carried by every JSON log line, error report and span: which deployment
    // and which build produced it. APP_ENVIRONMENT tells staging from
    // production (both run NODE_ENV=production); default: NODE_ENV.
    APP_ENVIRONMENT: optional(label),
    // The build: the images get the commit SHA at build time (Dockerfile).
    APP_RELEASE: optional(
      z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/, 'letters, digits, ".", "_", "+", "-"'),
    ),

    // --- Error tracking, OPTIONAL (docs/observability.md#error-tracking) --
    // Sentry project DSN of the API. Unset: errors are logged only. Checked
    // here because Sentry ignores a malformed DSN silently.
    SENTRY_DSN: optional(
      z
        .url({ protocol: /^https?$/ })
        .regex(
          /^https?:\/\/\w+@[\w.-]+(?::\d+)?\/(?:[\w.-]+\/)*\d+$/,
          'must be a Sentry DSN: https://<public key>@<host>/<project id>',
        ),
    ),
    // Share of error events sent (1 = all).
    SENTRY_SAMPLE_RATE: emptyAsUnset(ratio.default(1)),

    // --- Tracing and metrics, OPTIONAL (docs/observability.md#opentelemetry)
    // OTLP/HTTP endpoint of a collector or provider, e.g. http://localhost:4318.
    // Unset: OpenTelemetry is not even loaded. The exporters also read the
    // standard OTEL_EXPORTER_OTLP_* variables (headers, per-signal endpoints).
    OTEL_EXPORTER_OTLP_ENDPOINT: optional(z.url({ protocol: /^https?$/ })),
    // Standard kill switch: true turns telemetry off whatever the endpoint.
    OTEL_SDK_DISABLED: optional(flag),
    OTEL_SERVICE_NAME: label.default('api'),
    // Standard sampler settings, validated here so a typo stops the boot.
    OTEL_TRACES_SAMPLER: optional(
      z.enum([
        'always_on',
        'always_off',
        'traceidratio',
        'parentbased_always_on',
        'parentbased_always_off',
        'parentbased_traceidratio',
      ]),
    ),
    OTEL_TRACES_SAMPLER_ARG: optional(ratio),
    // How often metrics are pushed.
    OTEL_METRIC_EXPORT_INTERVAL: emptyAsUnset(milliseconds(1_000, 3_600_000).default(60_000)),

    // A query slower than this is logged (statement only, never its values).
    // 0 turns the log off.
    DB_SLOW_QUERY_MS: emptyAsUnset(milliseconds(0, 600_000).default(500)),
    // Connections one API instance may hold (pg's pool; 10 is pg's default).
    // Every instance at its maximum must fit in the database's connection
    // limit (docs/database.md#connections).
    DB_POOL_MAX: emptyAsUnset(z.coerce.number().int().min(1).max(100).default(10)),
    // The database cancels a statement that runs longer (a lock wait, a
    // runaway query): no request holds a connection forever. Raise it for a
    // project whose requests legitimately run long queries.
    DB_STATEMENT_TIMEOUT_MS: emptyAsUnset(milliseconds(1_000, 600_000).default(30_000)),

    // --- Redis, OPTIONAL (docs/architecture.md#redis) ---------------------
    // redis:// or rediss:// (TLS). Unset: nothing connects to Redis and every
    // feature uses its in-process implementation.
    REDIS_URL: optional(redisUrl),
    // Prepended to every key, so several apps or environments can share a
    // Redis without colliding.
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,31}:$/, 'lowercase name ending with ":", e.g. app:')
      .default('app:'),
    // true: Redis is a hard dependency (readiness fails while it is down).
    // false (default): features degrade (docs/architecture.md#degradation).
    REDIS_REQUIRED: flag.default(false),
    // Longest wait for one command; a slow Redis must not slow every request.
    REDIS_COMMAND_TIMEOUT_MS: emptyAsUnset(milliseconds(10, 60_000).default(500)),

    // Where rate limit counters live: memory (one instance) or redis (shared
    // by every instance, docs/security.md#rate-limiting).
    RATE_LIMIT_STORE: z.enum(['memory', 'redis']).default('memory'),
    // Where cache entries live (docs/architecture.md#cache).
    CACHE_STORE: z.enum(['memory', 'redis']).default('memory'),
  })
  .superRefine((values, ctx) => {
    // Browsers drop SameSite=None cookies that are not Secure, and cookies
    // are Secure in production only.
    if (values.AUTH_COOKIE_SAMESITE === 'none' && values.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_COOKIE_SAMESITE'],
        message: 'none requires Secure cookies, which are only set in production',
      });
    }
    if (values.TRUST_PROXY === undefined && values.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message:
          'required in production: the number of proxy hops in front of the API, e.g. 1 behind the web image',
      });
    }
    if (values.JWT_ACCESS_SECRET_PREVIOUS === values.JWT_ACCESS_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_SECRET_PREVIOUS'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }
    // A feature told to use Redis without a Redis to use is a configuration
    // error, not something to discover at the first request.
    if (values.REDIS_URL === undefined) {
      for (const name of ['RATE_LIMIT_STORE', 'CACHE_STORE'] as const) {
        if (values[name] === 'redis') {
          ctx.addIssue({ code: 'custom', path: [name], message: 'redis requires REDIS_URL' });
        }
      }
      if (values.REDIS_REQUIRED) {
        ctx.addIssue({ code: 'custom', path: ['REDIS_REQUIRED'], message: 'requires REDIS_URL' });
      }
    }
    // Error reports leave the network: encrypted in production.
    if (values.NODE_ENV === 'production' && values.SENTRY_DSN?.startsWith('http:') === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['SENTRY_DSN'],
        message: 'must be https in production',
      });
    }
  })
  .transform((values) => ({
    ...values,
    HOST: values.HOST ?? (values.NODE_ENV === 'production' ? undefined : '127.0.0.1'),
    TRUST_PROXY: values.TRUST_PROXY ?? 'loopback',
    // Machines read production logs, people read the rest.
    LOG_FORMAT: values.LOG_FORMAT ?? (values.NODE_ENV === 'production' ? 'json' : 'text'),
    APP_ENVIRONMENT: values.APP_ENVIRONMENT ?? values.NODE_ENV,
    APP_RELEASE: values.APP_RELEASE ?? 'unversioned',
  }));

export type Env = z.infer<typeof EnvSchema>;

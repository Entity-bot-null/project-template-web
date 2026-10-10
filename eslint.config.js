import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// SQL injection: the tagged templates ($queryRaw`...${value}`) parameterize
// every value; the *Unsafe variants do not. Banned everywhere, scripts and
// tests included.
const RAW_SQL_BAN = [
  {
    property: '$queryRawUnsafe',
    message: 'Use the $queryRaw tagged template (docs/security.md#sql-injection).',
  },
  {
    property: '$executeRawUnsafe',
    message: 'Use the $executeRaw tagged template (docs/security.md#sql-injection).',
  },
];

// One configuration for the whole repository: `pnpm lint` runs it once from
// the root, the pre-commit hook runs it on staged files, CI runs it on
// everything. Type-aware rules read each file's own tsconfig. Formatting is
// Prettier's job; eslint-config-prettier (last) switches off the overlap.
export default defineConfig(
  globalIgnores([
    '**/dist/',
    '**/dist-dev/',
    '**/coverage/',
    'playwright-report/',
    'test-results/',
    'apps/api/src/prisma/generated/',
    'apps/web/src/api/schema.d.ts',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-console': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      // Raw HTML bypasses React's escaping (XSS). Sanitize first (DOMPurify)
      // and disable this line with the reason (docs/security.md#csrf-cors-xss).
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Raw HTML skips React escaping: sanitize it and justify the exception.',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Configuration is parsed and validated once (apps/api/src/env); the
      // rest of the code imports the result instead of reading raw strings.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Import the validated `env` (apps/api/src/env/env.ts) instead.',
        },
        ...RAW_SQL_BAN,
      ],
    },
  },

  // Plain JavaScript (configuration files, scripts): no type information.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  // API: Node.js and NestJS.
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      // Nest modules are empty classes that carry decorators.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      // Optional infrastructure stays behind its adapters, so a project that
      // does not configure it never depends on it (docs/architecture.md).
      'no-restricted-imports': [
        'error',
        {
          paths: ['@redis/client', 'redis', 'ioredis'].map((name) => ({
            name,
            message:
              'Use CacheService, LockService or IdempotencyService; only src/infrastructure talks to Redis (docs/architecture.md#redis).',
          })),
          patterns: [
            {
              group: ['**/infrastructure/redis/redis.service*'],
              importNames: ['RedisService'],
              message:
                'Feature code uses the adapters (CacheService, LockService, IdempotencyService), not raw Redis commands (docs/architecture.md#redis).',
            },
            {
              group: ['@sentry/*'],
              message:
                'Report through errorTracker() (src/observability/error-tracker.ts): Sentry stays optional and swappable.',
            },
            {
              group: [
                '@opentelemetry/sdk-*',
                '@opentelemetry/exporter-*',
                '@opentelemetry/instrumentation*',
                '@opentelemetry/resources',
              ],
              message:
                'The OpenTelemetry SDK loads only when telemetry is on (src/observability/telemetry-sdk.ts). Use @opentelemetry/api or src/observability/metrics.ts.',
            },
          ],
        },
      ],
    },
  },

  // The adapters those imports are reserved for, the readiness probe, and the
  // specs and test helper that read metrics from an in-memory SDK.
  {
    files: [
      'apps/api/src/infrastructure/**',
      'apps/api/src/health/**',
      'apps/api/src/observability/sentry*.ts',
      'apps/api/src/observability/telemetry-sdk.ts',
      'apps/api/src/observability/telemetry.spec.ts',
      'apps/api/src/observability/metrics-catalog.spec.ts',
      'apps/api/test/metrics.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Web: browser and React.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Error tracking is optional and lazy: its SDK is imported in one place.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@sentry/*'],
              message:
                'Report through reportError() (src/monitoring/errorTracking.ts): the SDK loads only when configured.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/src/monitoring/sentry*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Tests: mocks and fixtures need some latitude.
  {
    files: ['**/*.spec.{ts,tsx}', 'apps/api/test/**', 'e2e/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // The only files that may read process.env or print to the console:
  // the env module itself, command-line entry points, configs and tooling.
  // The raw SQL ban stays.
  {
    files: [
      'apps/api/src/env/env.ts',
      'apps/api/src/openapi/export.ts',
      'apps/api/src/seed/run.ts',
      'apps/api/src/users/create-user.cli.ts',
      'apps/api/test/**',
      'apps/api/scripts/**',
      'apps/api/*.config.ts',
      'apps/web/vite.config.ts',
      'apps/web/scripts/**',
      'scripts/**',
      'e2e/**',
      'playwright.config.ts',
    ],
    rules: {
      'no-restricted-properties': ['error', ...RAW_SQL_BAN],
      'no-console': 'off',
    },
  },

  prettier,
);

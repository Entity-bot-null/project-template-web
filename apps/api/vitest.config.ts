import { configDefaults, defineConfig } from 'vitest/config';

// Unit specs (*.spec.ts, next to the code): no database, no network.
// Integration specs (*.int.spec.ts) have their own config.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    exclude: [...configDefaults.exclude, 'src/**/*.int.spec.ts'],
    restoreMocks: true,
    // Fixed, fake values: unit specs never read a .env file (env.ts skips it
    // under NODE_ENV=test), so a developer's own settings never leak in.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unit@127.0.0.1:5432/unit',
      JWT_ACCESS_SECRET: 'unit-only-secret-not-for-real-use-'.padEnd(64, '0'),
    },
    // Unit coverage measures the logic: services, guards, pipes, filters,
    // utilities. Wiring is verified by the integration suite instead.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.int.spec.ts',
        'src/prisma/generated/**',
        // Wiring: routes, decorators, module graphs (*.int.spec.ts).
        'src/**/*.controller.ts',
        'src/**/*.module.ts',
        // Process entry points: exercised by the integration and E2E suites.
        'src/main.ts',
        'src/server.ts',
        'src/openapi/export.ts',
        'src/seed/run.ts',
        'src/users/create-user.cli.ts',
      ],
      reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
      // Ratchet: the unit coverage measured when the template was built,
      // rounded down. Raise it as coverage grows; lower it only in a reviewed
      // pull request that says why (docs/testing.md#coverage).
      thresholds: {
        lines: 95,
        functions: 91,
        branches: 87,
        statements: 94,
      },
    },
  },
});

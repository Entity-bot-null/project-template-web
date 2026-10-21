/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';

// Astro's own Vite setup, so specs can render .astro components with the
// container API, the way the build renders them.
export default getViteConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts'],
      reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
      // Ratchet: the coverage measured when the landing was added. Lower it
      // only in a reviewed pull request that says why (docs/testing.md#coverage).
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});

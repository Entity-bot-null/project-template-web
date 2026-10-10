/// <reference types="vitest/config" />
import type { ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Where the dev server and `vite preview` forward /api. The browser only ever
// talks to its own origin, in development as behind the production web
// server, so the refresh cookie stays same-origin and no CORS is involved.
// An IP, not localhost: the API listens on IPv4 loopback in development, and
// localhost can resolve to ::1 first.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';

// /app-config.json, the deployment settings the app reads at runtime
// (src/monitoring/runtimeConfig.ts), from this process's environment: the same
// file the production web server writes from its own (apps/web/nginx). Empty
// WEB_SENTRY_DSN: error tracking off, the default. WEB_VITALS_SAMPLE_RATE 0:
// Web Vitals off; every page load reports them by default.
function runtimeConfig(): Plugin {
  const serve = (_request: unknown, response: ServerResponse) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.end(
      JSON.stringify({
        environment: process.env.APP_ENVIRONMENT ?? 'development',
        release: process.env.APP_RELEASE ?? 'unversioned',
        sentryDsn: process.env.WEB_SENTRY_DSN ?? '',
        sentrySampleRate: process.env.WEB_SENTRY_SAMPLE_RATE ?? '1',
        webVitalsSampleRate: process.env.WEB_VITALS_SAMPLE_RATE ?? '1',
      }),
    );
  };
  return {
    name: 'runtime-config',
    configureServer(server) {
      server.middlewares.use('/app-config.json', serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/app-config.json', serve);
    },
  };
}

export default defineConfig({
  plugins: [react(), runtimeConfig()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': apiTarget },
  },
  // `vite preview` reuses server.proxy.
  preview: {
    port: 4173,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.spec.{ts,tsx}'],
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.spec.{ts,tsx}',
        'src/test/**',
        'src/api/schema.d.ts',
        // Entry point: mounts the app, exercised by the E2E suite.
        'src/main.tsx',
      ],
      reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
      // Ratchet: the coverage measured when the template was built (rounded
      // down). Raise it as coverage grows; lower it only in a reviewed pull
      // request that says why (docs/testing.md#coverage).
      thresholds: {
        lines: 95,
        functions: 93,
        branches: 87,
        statements: 93,
      },
    },
  },
});

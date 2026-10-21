import { defineConfig, devices } from '@playwright/test';
import { LANDING_URL } from './e2e/support/landing.js';

// End-to-end suite (e2e/*.e2e.ts): a real browser against the built web app,
// the built landing and the built API on their own ports, the API on its own database
// (`<db>_e2e`, reseeded every run). Needs `pnpm build` and the database
// (`pnpm db:up`) first, and the browser once: `pnpm exec playwright install chromium`.
const CI = process.env.CI !== undefined;
const API_PORT = 3100;
const WEB_URL = 'http://localhost:4173';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // One database, so one worker: tests never see each other's writes mid-run.
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  reporter: CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter api e2e:server',
      url: `http://127.0.0.1:${API_PORT}/api/health/ready`,
      // APP_ORIGIN: where links in messages point (the web server below).
      env: { PORT: String(API_PORT), APP_ORIGIN: WEB_URL },
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      // The built SPA under /app/, with /api forwarded to the API above: one
      // origin, as in production. The specs open /app/... on it.
      command: 'pnpm --filter web preview',
      url: `${WEB_URL}/app/`,
      env: { API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      // The built landing: static pages, built for this address.
      command: 'pnpm --filter landing preview',
      url: LANDING_URL,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});

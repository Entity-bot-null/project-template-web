import { readFileSync } from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { configureApp } from '../app.setup.js';
import { buildOpenApiDocument, OPENAPI_JSON_PATH } from './openapi.js';

// Contract drift guard: the committed openapi/openapi.json (what the web app
// generates its client types from) must match what the controllers produce.
// When it fails, run `pnpm contract` at the repository root and commit both
// generated files.
describe('OpenAPI contract', () => {
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    document = buildOpenApiDocument(app);
  });

  const operations = () =>
    Object.entries(document.paths).flatMap(([path, item]) =>
      Object.values(item)
        .filter((op): op is { responses: Record<string, unknown> } => {
          return typeof op === 'object' && op !== null && 'responses' in op;
        })
        .map((op) => ({ path, op })),
    );

  it('matches the committed openapi/openapi.json (run `pnpm contract` when this fails)', () => {
    const committed: unknown = JSON.parse(readFileSync(OPENAPI_JSON_PATH, 'utf8'));
    expect(document).toEqual(committed);
  });

  // Every route anyone may call, each with its reason: a new public route is a
  // decision, added here. /api/auth/ is the anonymous namespace: the web client
  // never sends its bearer token there (apps/web/src/auth/middleware.ts), so a
  // route that needs a session does not belong under it.
  const PUBLIC_ROUTES = new Set([
    // Sign-in, and the session cookie it sets, renews and ends.
    'POST /api/auth/sign-in',
    'POST /api/auth/refresh',
    'POST /api/auth/logout',
    // What the deployment offers, read before anyone signs in.
    'GET /api/auth/capabilities',
    // Asking for an emailed link, and using one: sign-up, password recovery,
    // change of email, invitations.
    'POST /api/auth/sign-ups',
    'POST /api/auth/sign-ups/confirm',
    'POST /api/auth/password-resets',
    'POST /api/auth/password-resets/confirm',
    'POST /api/auth/email-changes/confirm',
    'POST /api/auth/email-changes/revert',
    'POST /api/auth/invitations/accept',
    // The probes.
    'GET /api/health/live',
    'GET /api/health/ready',
    // Web Vitals, sent signed in or not (docs/security.md#web-vitals).
    'POST /api/telemetry/web-vitals',
  ]);

  const routes = () =>
    Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, op]) => typeof op === 'object' && op !== null && 'responses' in op)
        .map(([method, op]) => ({
          route: `${method.toUpperCase()} ${path}`,
          path,
          bearer: ((op as { security?: Record<string, unknown>[] }).security ?? []).some(
            (requirement) => 'bearer' in requirement,
          ),
        })),
    );

  it('declares the bearer requirement on every route but the listed public ones', () => {
    const unprotected = routes()
      .filter(({ route, bearer }) => !bearer && !PUBLIC_ROUTES.has(route))
      .map(({ route }) => route);
    expect(unprotected).toEqual([]);
  });

  it('keeps /api/auth/ anonymous: the web client sends no token there', () => {
    const authenticated = routes()
      .filter(({ path, bearer }) => bearer && path.startsWith('/api/auth/'))
      .map(({ route }) => route);
    expect(authenticated).toEqual([]);
  });

  it('lists as public only routes that exist and are public', () => {
    const publicOnes = new Set(
      routes()
        .filter(({ bearer }) => !bearer)
        .map(({ route }) => route),
    );
    expect([...PUBLIC_ROUTES].filter((route) => !publicOnes.has(route))).toEqual([]);
  });

  it('keeps every route under /api with a documented success response', () => {
    expect(operations().length).toBeGreaterThan(0);
    for (const { path, op } of operations()) {
      expect(path.startsWith('/api/'), path).toBe(true);
      const statuses = Object.keys(op.responses);
      expect(
        statuses.some((status) => status.startsWith('2')),
        path,
      ).toBe(true);
    }
  });

  it('documents the rate limit on every route except the health probes', () => {
    for (const { path, op } of operations()) {
      expect('429' in op.responses, path).toBe(!path.startsWith('/api/health/'));
    }
  });
});

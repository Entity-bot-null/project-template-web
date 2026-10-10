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

  it('declares the bearer requirement on every route outside /api/auth and /api/health', () => {
    const publicRoute = (path: string) =>
      path.startsWith('/api/auth/') || path.startsWith('/api/health/');
    const unprotected = operations()
      .filter(({ path }) => !publicRoute(path))
      .filter(({ op }) => {
        const security = (op as { security?: Record<string, unknown>[] }).security ?? [];
        return !security.some((requirement) => 'bearer' in requirement);
      })
      .map(({ path }) => path);
    expect(unprotected).toEqual([]);
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

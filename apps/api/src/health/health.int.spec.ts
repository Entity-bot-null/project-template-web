import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../test/app.js';
import { envelopeOf } from '../../test/http.js';

describe('Health probes (integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('reports liveness', async () => {
    const res = await request(t.server).get('/api/health/live').expect(200);
    expect(res.body).toEqual({
      data: { status: 'ok', uptime: expect.any(Number) as number },
      message: 'Operation successful',
    });
  });

  it('reports readiness with a live database', async () => {
    const res = await request(t.server).get('/api/health/ready').expect(200);
    expect(envelopeOf(res).data).toEqual({
      status: 'ok',
      checks: { database: 'ok', redis: 'disabled', mail: 'disabled' },
    });
  });

  it('is never rate limited', async () => {
    const res = await request(t.server).get('/api/health/live').expect(200);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });
});

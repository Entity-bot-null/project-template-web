import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../test/app.js';

// The cross-cutting behavior every route shares: envelope, errors, security
// headers, request ids, CORS.
describe('HTTP pipeline (integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('answers an unknown /api path with the error envelope', async () => {
    const res = await request(t.server).get('/api/does-not-exist').expect(404);
    expect(res.body).toEqual({ data: null, message: expect.any(String) as string });
  });

  it('answers a malformed JSON body with a 400 envelope', async () => {
    const res = await request(t.server)
      .post('/api/auth/sign-in')
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400);
    expect(res.body).toMatchObject({ data: null });
  });

  it('refuses a body over the size limit', async () => {
    const res = await request(t.server)
      .post('/api/auth/sign-in')
      .send({ email: 'a@example.com', password: 'x'.repeat(200 * 1024) })
      .expect(413);
    expect(res.body).toMatchObject({ data: null });
  });

  it('refuses bodies that are not JSON, before parsing them', async () => {
    const form = await request(t.server)
      .post('/api/auth/sign-in')
      .type('form')
      .send('email=a%40example.com&password=x')
      .expect(415);
    expect(form.body).toEqual({ data: null, message: 'Request bodies must be application/json' });
    await request(t.server)
      .post('/api/auth/sign-in')
      .set('Content-Type', 'text/plain')
      .send('{"email":"a@example.com","password":"x"}')
      .expect(415);
  });

  it('sends security headers and hides the framework', async () => {
    const res = await request(t.server).get('/api/health/live').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('forbids caching any response: they carry tokens and personal data', async () => {
    const res = await request(t.server).get('/api/health/live').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('gives every response a request id, keeping a well-formed incoming one', async () => {
    const generated = await request(t.server).get('/api/health/live');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const kept = await request(t.server).get('/api/health/live').set('X-Request-Id', 'edge-42');
    expect(kept.headers['x-request-id']).toBe('edge-42');
  });

  it('sends no CORS headers while no origin is configured', async () => {
    const res = await request(t.server)
      .get('/api/health/live')
      .set('Origin', 'https://other.example.net');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

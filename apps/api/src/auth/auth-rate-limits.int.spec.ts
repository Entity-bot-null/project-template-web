import { getOptionsToken } from '@nestjs/throttler';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../test/app.js';
import { rateLimitOptions } from '../common/guards/rate-limit.guard.js';
import {
  RATE_LIMIT_STORE,
  type RateLimitStore,
} from '../infrastructure/rate-limit/rate-limit.store.js';
import { REFRESH_RATE_LIMIT, SIGN_IN_RATE_LIMIT } from './auth.constants.js';

// The sign-in and refresh limits are counted on top of the global limit:
// whichever is tighter decides. The integration env sets a very loose global
// limit (vitest.config.int.ts); one test tightens it below the sign-in limit.

const signInAttempt = (t: TestApp) =>
  request(t.server)
    .post('/api/auth/sign-in')
    .send({ email: 'nobody@example.com', password: 'wrong-password' });

describe('Auth rate limits (integration)', () => {
  const apps: TestApp[] = [];

  afterEach(async () => {
    for (const t of apps.splice(0)) await t.app.close();
  });

  async function app(globalLimit?: number): Promise<TestApp> {
    const t = await createTestApp((builder) =>
      globalLimit === undefined
        ? builder
        : builder.overrideProvider(getOptionsToken()).useFactory({
            // The application's throttlers, with a global limit of `globalLimit`.
            factory: (storage: RateLimitStore) =>
              rateLimitOptions(storage, { limit: globalLimit, windowSec: 60 }),
            inject: [RATE_LIMIT_STORE],
          }),
    );
    apps.push(t);
    return t;
  }

  it('applies the sign-in limit on top of a looser global one', async () => {
    const t = await app();
    const first = await signInAttempt(t).expect(401);
    // Both limits are reported: the global one, and the route's own.
    expect(first.headers['x-ratelimit-limit']).toBe('100000');
    expect(first.headers['x-ratelimit-limit-route']).toBe(String(SIGN_IN_RATE_LIMIT.limit));
    for (let attempt = 1; attempt < SIGN_IN_RATE_LIMIT.limit; attempt += 1) {
      await signInAttempt(t).expect(401);
    }
    const blocked = await signInAttempt(t).expect(429);
    expect(blocked.body).toEqual({ data: null, message: 'Too many requests, retry later' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('applies the global limit to sign-in too, when it is the tighter one', async () => {
    const t = await app(3);
    for (let attempt = 0; attempt < 3; attempt += 1) await signInAttempt(t).expect(401);
    const blocked = await signInAttempt(t).expect(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('applies the refresh limit on top of the global one', async () => {
    const t = await app();
    const refresh = () =>
      request(t.server).post('/api/auth/refresh').set('Cookie', 'refresh_token=not-a-session');
    for (let attempt = 0; attempt < REFRESH_RATE_LIMIT.limit; attempt += 1) {
      await refresh().expect(401);
    }
    await refresh().expect(429);
  });
});

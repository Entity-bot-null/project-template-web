import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryRateLimitStore } from '../../infrastructure/rate-limit/rate-limit.store.js';
import { RateLimitGuard, rateLimitOptions, RouteRateLimit } from './rate-limit.guard.js';

class Routes {
  @RouteRateLimit({ limit: 2, ttlSec: 60 })
  signIn(): void {
    // A route with a tighter limit of its own.
  }

  list(): void {
    // A route with the global limit only.
  }
}

function request(handler: 'signIn' | 'list') {
  const headers: Record<string, unknown> = {};
  const res = {
    header: (name: string, value: unknown) => {
      headers[name] = value;
    },
    setHeader: (name: string, value: unknown) => {
      headers[name] = value;
    },
  };
  const req = { ip: '203.0.113.7', headers: {} };
  const context = {
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { context, headers };
}

const stores: InMemoryRateLimitStore[] = [];

async function guardWith(globalLimit: number) {
  const storage = new InMemoryRateLimitStore();
  stores.push(storage);
  const guard = new RateLimitGuard(
    rateLimitOptions(storage, { limit: globalLimit, windowSec: 60 }),
    storage,
    new Reflector(),
  );
  await guard.onModuleInit();
  const attempt = (handler: 'signIn' | 'list') => guard.canActivate(request(handler).context);
  return { guard, storage, attempt };
}

afterEach(() => {
  for (const storage of stores.splice(0)) storage.onApplicationShutdown();
});

describe('RateLimitGuard', () => {
  it('counts a route limit on top of a looser global one', async () => {
    const { attempt } = await guardWith(100);
    await expect(attempt('signIn')).resolves.toBe(true);
    await expect(attempt('signIn')).resolves.toBe(true);
    await expect(attempt('signIn')).rejects.toBeInstanceOf(ThrottlerException);
    // Another route is not affected by sign-in's own limit.
    await expect(attempt('list')).resolves.toBe(true);
  });

  it('keeps the global limit on a route with a looser limit of its own', async () => {
    const { attempt } = await guardWith(1);
    await expect(attempt('signIn')).resolves.toBe(true);
    await expect(attempt('signIn')).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('answers with the standard Retry-After whichever limit blocked', async () => {
    const { guard, attempt } = await guardWith(100);
    await attempt('signIn');
    await attempt('signIn');
    const { context, headers } = request('signIn');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ThrottlerException);
    expect(headers['Retry-After']).toBe('60');
    expect(headers['X-RateLimit-Limit']).toBe(100);
    expect(headers['X-RateLimit-Limit-route']).toBeUndefined();
  });

  it('keeps no route counter for routes without a limit of their own', async () => {
    const { storage, attempt } = await guardWith(100);
    for (let i = 0; i < 5; i += 1) await attempt('list');
    expect(storage.storage.size).toBe(1);
    await attempt('signIn');
    expect(storage.storage.size).toBe(3);
  });
});

import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { FetchMetadataGuard } from './fetch-metadata.guard.js';

vi.mock('../../env/env.js', () => ({ env: { CORS_ORIGINS: ['https://app.example.com'] } }));

function contextWith(headers: Record<string, string>): ExecutionContext {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { get: (name: string) => lower[name.toLowerCase()] };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('FetchMetadataGuard', () => {
  const guard = new FetchMetadataGuard();

  it('lets same-origin and user-initiated requests through', () => {
    for (const site of ['same-origin', 'none']) {
      expect(guard.canActivate(contextWith({ 'Sec-Fetch-Site': site }))).toBe(true);
    }
  });

  it('lets requests without fetch metadata through (non-browser clients)', () => {
    expect(guard.canActivate(contextWith({}))).toBe(true);
  });

  it('refuses cross-site requests, and same-site ones from a sibling subdomain', () => {
    for (const site of ['cross-site', 'same-site']) {
      expect(() =>
        guard.canActivate(
          contextWith({ 'Sec-Fetch-Site': site, Origin: 'https://evil.example.com' }),
        ),
      ).toThrow(ForbiddenException);
      expect(() => guard.canActivate(contextWith({ 'Sec-Fetch-Site': site }))).toThrow(
        ForbiddenException,
      );
    }
  });

  it('accepts a cross-origin request from an allowed CORS origin', () => {
    for (const site of ['cross-site', 'same-site']) {
      expect(
        guard.canActivate(
          contextWith({ 'Sec-Fetch-Site': site, Origin: 'https://app.example.com' }),
        ),
      ).toBe(true);
    }
  });
});

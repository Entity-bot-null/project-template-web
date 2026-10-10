import { type ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { FetchMetadataGuard } from './fetch-metadata.guard.js';

const env = vi.hoisted(
  (): { NODE_ENV: string; CORS_ORIGINS: string[]; APP_ORIGIN: string | undefined } => ({
    NODE_ENV: 'test',
    CORS_ORIGINS: ['https://app.example.com'],
    APP_ORIGIN: 'https://web.example.com',
  }),
);
vi.mock('../../env/env.js', () => ({ env }));

/** A request to the API at http://api.internal:3000 (what the proxy calls it). */
function contextWith(headers: Record<string, string>): ExecutionContext {
  const lower = Object.fromEntries(
    Object.entries({ Host: 'api.internal:3000', ...headers }).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const req = { protocol: 'http', get: (name: string) => lower[name.toLowerCase()] };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('FetchMetadataGuard', () => {
  const guard = new FetchMetadataGuard();

  it('lets same-origin and user-initiated requests through', () => {
    for (const site of ['same-origin', 'none']) {
      expect(guard.canActivate(contextWith({ 'Sec-Fetch-Site': site }))).toBe(true);
    }
  });

  it('lets requests without fetch metadata or Origin through (non-browser clients)', () => {
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

  it('refuses a request without fetch metadata whose Origin is another site (older browsers)', () => {
    for (const origin of ['https://evil.example.com', 'https://sibling.example.com', 'null']) {
      expect(() => guard.canActivate(contextWith({ Origin: origin }))).toThrow(ForbiddenException);
    }
    // Another scheme or port is another origin.
    expect(() => guard.canActivate(contextWith({ Origin: 'https://api.internal:3000' }))).toThrow(
      ForbiddenException,
    );
  });

  it("accepts one without fetch metadata from the app's own origin, or an allowed CORS origin", () => {
    for (const origin of [
      'https://web.example.com', // APP_ORIGIN
      'http://api.internal:3000', // the address the request was sent to
      'https://app.example.com', // CORS_ORIGINS
    ]) {
      expect(guard.canActivate(contextWith({ Origin: origin }))).toBe(true);
    }
  });

  it('warns at boot in production without APP_ORIGIN, where a proxy hides the public host', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    Object.assign(env, { NODE_ENV: 'production', APP_ORIGIN: undefined });
    try {
      new FetchMetadataGuard().onModuleInit();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('APP_ORIGIN is not set'));
      warn.mockClear();
      Object.assign(env, { APP_ORIGIN: 'https://web.example.com' });
      new FetchMetadataGuard().onModuleInit();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      Object.assign(env, { NODE_ENV: 'test', APP_ORIGIN: 'https://web.example.com' });
    }
  });
});

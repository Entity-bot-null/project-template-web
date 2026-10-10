import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  disabledErrorTracker,
  errorTracker,
  setErrorTracker,
  startErrorTracking,
} from './error-tracker.js';

const settings = { APP_ENVIRONMENT: 'test', APP_RELEASE: 'r1', SENTRY_SAMPLE_RATE: 1 };

afterEach(async () => {
  await errorTracker().close(100);
  setErrorTracker(disabledErrorTracker);
  vi.unstubAllGlobals();
});

describe('startErrorTracking', () => {
  it('stays a no-op without SENTRY_DSN: optional, nothing to configure', async () => {
    const tracker = await startErrorTracking({ ...settings, SENTRY_DSN: undefined });
    expect(tracker.enabled).toBe(false);
    expect(errorTracker()).toBe(disabledErrorTracker);
    expect(() => {
      tracker.capture(new Error('ignored'));
    }).not.toThrow();
    await expect(tracker.flush(10)).resolves.toBeUndefined();
  });

  it('installs the Sentry tracker as the process-wide one when configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}'))),
    );
    const tracker = await startErrorTracking({
      ...settings,
      SENTRY_DSN: 'https://key@o1.ingest.example.com/1',
    });
    expect(tracker.enabled).toBe(true);
    expect(errorTracker()).toBe(tracker);
  });
});

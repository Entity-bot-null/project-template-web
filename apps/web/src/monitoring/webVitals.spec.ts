import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from './runtimeConfig';
import { landingPath, startWebVitals } from './webVitals';

const config = (sampleRate?: number): (() => Promise<RuntimeConfig>) => {
  const loaded: RuntimeConfig =
    sampleRate === undefined
      ? DEFAULT_RUNTIME_CONFIG
      : { ...DEFAULT_RUNTIME_CONFIG, webVitals: { sampleRate } };
  return () => Promise.resolve(loaded);
};

describe('startWebVitals', () => {
  it('loads nothing when the deployment reports no Web Vitals', async () => {
    const loadReporter = vi.fn();
    await expect(startWebVitals({ loadConfig: config(), loadReporter })).resolves.toBe(false);
    expect(loadReporter).not.toHaveBeenCalled();
  });

  it('reports the page loads the sample rate picks, and loads nothing for the others', async () => {
    const reportWebVitals = vi.fn();
    const loadReporter = vi.fn(() => Promise.resolve({ reportWebVitals }));

    await expect(
      startWebVitals({ loadConfig: config(0.25), loadReporter, random: () => 0.24 }),
    ).resolves.toBe(true);
    expect(reportWebVitals).toHaveBeenCalledWith(window.location.pathname);

    await expect(
      startWebVitals({ loadConfig: config(0.25), loadReporter, random: () => 0.25 }),
    ).resolves.toBe(false);
    expect(loadReporter).toHaveBeenCalledTimes(1);
  });

  it('never breaks the app when the library cannot load', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      startWebVitals({
        loadConfig: config(1),
        loadReporter: () => Promise.reject(new Error('chunk failed to load')),
      }),
    ).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalledWith('Web Vitals could not start', expect.any(Error));
  });
});

describe('landingPath', () => {
  it('is the path of the document as loaded, without its query string', () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { name: 'https://app.example.com/admin/users?page=2#top' } as PerformanceNavigationTiming,
    ]);
    expect(landingPath()).toBe('/admin/users');
  });

  it('falls back to the current path where the browser has no navigation timing', () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    expect(landingPath()).toBe(window.location.pathname);
  });
});

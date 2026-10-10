import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '../test/http';
import { reportError, resetErrorTracking, startErrorTracking } from './errorTracking';
import { DEFAULT_RUNTIME_CONFIG, loadRuntimeConfig, parseRuntimeConfig } from './runtimeConfig';

afterEach(() => {
  resetErrorTracking();
});

const enabled = {
  ...DEFAULT_RUNTIME_CONFIG,
  environment: 'staging',
  release: 'abc1234',
  errorTracking: { dsn: 'https://key@o1.ingest.example.com/1', sampleRate: 0.5 },
};

describe('startErrorTracking', () => {
  it('loads nothing when the deployment has no DSN', async () => {
    const loadSdk = vi.fn();
    await expect(
      startErrorTracking({ loadConfig: () => Promise.resolve(DEFAULT_RUNTIME_CONFIG), loadSdk }),
    ).resolves.toBe(false);
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('starts the SDK with the deployment identity, then sends what happened before', async () => {
    const send = vi.fn();
    const initSentry = vi.fn(() => send);
    const early = new Error('during boot');
    reportError(early, { source: 'route' });

    await expect(
      startErrorTracking({
        loadConfig: () => Promise.resolve(enabled),
        loadSdk: () => Promise.resolve({ initSentry }),
      }),
    ).resolves.toBe(true);

    expect(initSentry).toHaveBeenCalledWith({
      dsn: 'https://key@o1.ingest.example.com/1',
      sampleRate: 0.5,
      environment: 'staging',
      release: 'abc1234',
    });
    expect(send).toHaveBeenCalledWith(early, { source: 'route' });
    const later = new Error('later');
    reportError(later, { source: 'route' });
    expect(send).toHaveBeenLastCalledWith(later, { source: 'route' });
  });

  it('keeps uncaught errors that happen while the configuration loads', async () => {
    const send = vi.fn();
    let finishLoading!: () => void;
    const starting = startErrorTracking({
      loadConfig: () =>
        new Promise((resolve) => {
          finishLoading = () => {
            resolve(enabled);
          };
        }),
      loadSdk: () => Promise.resolve({ initSentry: () => send }),
    });
    const crash = new Error('uncaught');
    window.dispatchEvent(new ErrorEvent('error', { error: crash, message: 'uncaught' }));
    finishLoading();
    await starting;
    expect(send).toHaveBeenCalledWith(crash, { source: 'window' });
  });

  it('never breaks the app when the SDK cannot load', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      startErrorTracking({
        loadConfig: () => Promise.resolve(enabled),
        loadSdk: () => Promise.reject(new Error('chunk failed to load')),
      }),
    ).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });
});

describe('runtime configuration', () => {
  it('reads the file the web server writes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json(200, {
            environment: 'production',
            release: 'v1.4.0',
            sentryDsn: 'https://key@o1.ingest.example.com/9',
            sentrySampleRate: '0.25',
          }),
        ),
      ),
    );
    await expect(loadRuntimeConfig()).resolves.toEqual({
      environment: 'production',
      release: 'v1.4.0',
      errorTracking: { dsn: 'https://key@o1.ingest.example.com/9', sampleRate: 0.25 },
    });
  });

  it('falls back to "everything optional off" on a missing or broken file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('not found', { status: 404 }))),
    );
    await expect(loadRuntimeConfig()).resolves.toEqual(DEFAULT_RUNTIME_CONFIG);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await expect(loadRuntimeConfig()).resolves.toEqual(DEFAULT_RUNTIME_CONFIG);
    expect(parseRuntimeConfig('nonsense')).toEqual(DEFAULT_RUNTIME_CONFIG);
  });

  it('treats an empty DSN as off and a bad sample rate as 1', () => {
    expect(parseRuntimeConfig({ sentryDsn: '' }).errorTracking).toBeUndefined();
    expect(parseRuntimeConfig({ sentryDsn: 'javascript:alert(1)' }).errorTracking).toBeUndefined();
    expect(
      parseRuntimeConfig({ sentryDsn: 'https://k@h/1', sentrySampleRate: '7' }).errorTracking,
    ).toEqual({ dsn: 'https://k@h/1', sampleRate: 1 });
  });
});

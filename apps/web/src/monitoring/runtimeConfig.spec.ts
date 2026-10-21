import { describe, expect, it } from 'vitest';
import { json, stubFetch } from '../test/http';
import { loadRuntimeConfig } from './runtimeConfig';

describe('loadRuntimeConfig', () => {
  it("reads the deployment's settings from the app's own folder", async () => {
    // app-config.json next to the app's index.html: /app/app-config.json in a
    // build (apps/web/nginx and vite.config.ts serve it there), / in the specs.
    const { calls } = stubFetch({
      [`GET ${import.meta.env.BASE_URL}app-config.json`]: () =>
        json(200, { environment: 'staging', release: 'v2.0.0' }),
    });
    await expect(loadRuntimeConfig()).resolves.toEqual({
      environment: 'staging',
      release: 'v2.0.0',
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? '').origin).toBe(window.location.origin);
  });
});

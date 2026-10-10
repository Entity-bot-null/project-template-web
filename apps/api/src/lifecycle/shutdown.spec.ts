import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disabledErrorTracker, setErrorTracker } from '../observability/error-tracker.js';
import { GracefulShutdown, ShutdownState } from './shutdown.js';

const adapterFor = (server: Server) =>
  ({ httpAdapter: { getHttpServer: () => server } }) as unknown as HttpAdapterHost;

function get(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ port, host: '127.0.0.1', path: '/' }, (res) => {
      res.resume();
      res.on('end', () => {
        resolve(res.statusCode ?? 0);
      });
    })
      .on('error', reject)
      .end();
  });
}

let server: Server | undefined;
beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  setErrorTracker(disabledErrorTracker);
});

describe('GracefulShutdown', () => {
  it('lets the request in flight finish, then refuses new connections', async () => {
    let finishRequest!: () => void;
    server = createServer((_req, res) => {
      finishRequest = () => res.end('done');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const inFlight = get(port);
    await vi.waitFor(() => {
      expect(finishRequest).toBeDefined();
    });
    const state = new ShutdownState();
    const draining = new GracefulShutdown(state, adapterFor(server)).onModuleDestroy();
    expect(state.shuttingDown).toBe(true);

    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(drained).toBe(false); // still waiting for the request

    finishRequest();
    await expect(inFlight).resolves.toBe(200);
    await draining;
    await expect(get(port)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('has nothing to drain when the server is not listening (tests, scripts)', async () => {
    const idle = createServer();
    await expect(
      new GracefulShutdown(new ShutdownState(), adapterFor(idle)).onModuleDestroy(),
    ).resolves.toBeUndefined();
  });

  it('flushes error reports last', async () => {
    const close = vi.fn(() => Promise.resolve());
    setErrorTracker({ ...disabledErrorTracker, enabled: true, close });
    await new GracefulShutdown(
      new ShutdownState(),
      adapterFor(createServer()),
    ).onApplicationShutdown('SIGTERM');
    expect(close).toHaveBeenCalledOnce();
  });
});

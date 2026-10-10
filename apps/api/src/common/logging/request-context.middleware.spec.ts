import { EventEmitter, once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { env } from '../../env/env.js';
import { currentRequestId } from '../../observability/request-context.js';
import {
  clientIp,
  pathOf,
  REQUEST_ID_HEADER,
  requestContext,
} from './request-context.middleware.js';

function exchange(url: string, headers: Record<string, string> = {}) {
  const req = {
    method: 'GET',
    originalUrl: url,
    get: (name: string) => headers[name],
  } as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: false,
    writableFinished: false,
    setHeader: vi.fn(),
  }) as unknown as Response & EventEmitter;
  const next = vi.fn<() => void>();
  requestContext(req, res, next);
  return { req, res, next };
}

describe('requestContext', () => {
  it('gives the request a fresh id and echoes it in the response', () => {
    const { req, res, next } = exchange('/api/users');
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, req.id);
    expect(next).toHaveBeenCalledOnce();
  });

  it("keeps a caller's well-formed id and replaces anything else", () => {
    expect(exchange('/api/x', { [REQUEST_ID_HEADER]: 'trace-123.a_b' }).req.id).toBe(
      'trace-123.a_b',
    );
    const injected = exchange('/api/x', { [REQUEST_ID_HEADER]: 'bad id\nFAKE LOG LINE' }).req.id;
    expect(injected).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs one line per request with the path but never the query string', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { res, req } = exchange('/api/users?token=secret');
    res.emit('finish');
    expect(log).toHaveBeenCalledOnce();
    const [line] = log.mock.calls[0] ?? [];
    expect(String(line)).toContain(`GET /api/users 200`);
    expect(String(line)).toContain(req.id);
    expect(String(line)).not.toContain('secret');
  });

  it('names the client address and the caller, once a guard identified one', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { req, res } = exchange('/api/users/me');
    Object.assign(req, { ip: '::ffff:203.0.113.7', user: { id: 'user-1', role: 'member' } });
    res.emit('finish');
    const [line] = log.mock.calls[0] ?? [];
    expect(String(line)).toContain('ip=203.0.113.7 user=user-1');
  });

  it('runs the rest of the request inside its context, access line included', () => {
    let seenByHandler: string | undefined;
    let seenByAccessLog: string | undefined;
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      seenByAccessLog = currentRequestId();
    });
    const req = {
      method: 'GET',
      originalUrl: '/api/users',
      get: (name: string) => (name === REQUEST_ID_HEADER ? 'ctx-1' : undefined),
    } as unknown as Request;
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setHeader: vi.fn(),
    }) as unknown as Response & EventEmitter;
    requestContext(req, res, () => {
      seenByHandler = currentRequestId();
    });
    // The socket emits 'finish' later, from outside the request's async chain.
    res.emit('finish');
    expect(seenByHandler).toBe('ctx-1');
    expect(seenByAccessLog).toBe('ctx-1');
    expect(currentRequestId()).toBeUndefined();
  });

  it('logs once per request: a completed one at "finish", not again at "close"', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { res } = exchange('/api/users');
    Object.assign(res, { headersSent: true, writableFinished: true });
    res.emit('finish');
    res.emit('close');
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).not.toContain('aborted');
  });

  it('logs a request the client gave up on (a proxy timeout, a shutdown), marked aborted', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { req, res } = exchange('/api/reports?token=secret');
    // The connection closed before the response was sent: no 'finish'.
    res.emit('close');
    res.emit('close');
    expect(log).toHaveBeenCalledOnce();
    const [line] = log.mock.calls[0] ?? [];
    expect(String(line)).toMatch(/^GET \/api\/reports - \d+(\.\d+)?ms aborted ip=/);
    expect(String(line)).toContain(req.id);
    expect(String(line)).not.toContain('secret');
  });

  it('marks an aborted request in JSON lines, with no status when none was sent', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const format = env.LOG_FORMAT;
    env.LOG_FORMAT = 'json';
    try {
      const aborted = exchange('/api/reports?token=secret');
      aborted.res.emit('close');
      const completed = exchange('/api/users');
      completed.res.emit('finish');
      expect(log.mock.calls.map(([entry]): unknown => entry)).toEqual([
        {
          message: 'request aborted',
          requestId: aborted.req.id,
          method: 'GET',
          path: '/api/reports',
          statusCode: null,
          durationMs: expect.any(Number) as number,
          ip: 'unknown',
          userId: null,
          aborted: true,
        },
        {
          message: 'request completed',
          requestId: completed.req.id,
          method: 'GET',
          path: '/api/users',
          statusCode: 200,
          durationMs: expect.any(Number) as number,
          ip: 'unknown',
          userId: null,
        },
      ]);
    } finally {
      env.LOG_FORMAT = format;
    }
  });

  it('keeps health probes out of the default log level', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    exchange('/api/health/live').res.emit('finish');
    expect(log).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledOnce();
  });
});

// Node's own events, not emitted by hand: "close" follows "finish" on every
// response, and comes alone when the connection goes first.
describe('requestContext on a real connection', () => {
  /** Runs the middleware on an HTTP server; `handle` plays the route handler. */
  async function withServer(
    handle: (res: ServerResponse) => void,
    run: (url: string, server: Server) => Promise<void>,
  ): Promise<void> {
    const server = createServer((req, res) => {
      const request = Object.assign(req, {
        originalUrl: req.url ?? '/',
        get: (name: string) => req.headers[name.toLowerCase()],
      });
      requestContext(request as unknown as Request, res as unknown as Response, () => {
        handle(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await run(`http://127.0.0.1:${String(port)}`, server);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  /**
   * A handler that never finishes its answer, like a request stuck on a
   * dependency: it does `start` (nothing by default) and hands the response over.
   */
  function stuckHandler(start: (res: ServerResponse) => void = () => undefined) {
    let reached!: (res: ServerResponse) => void;
    const response = new Promise<ServerResponse>((resolve) => {
      reached = resolve;
    });
    const handle = (res: ServerResponse) => {
      start(res);
      reached(res);
    };
    return { handle, response };
  }

  it('logs a completed request once, although "close" follows "finish"', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let closed!: Promise<unknown>;
    await withServer(
      (res) => {
        closed = once(res, 'close');
        res.end('ok');
      },
      async (url) => {
        await (await fetch(`${url}/api/things`)).text();
        await closed;
      },
    );
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toMatch(/^GET \/api\/things 200 [\d.]+ms ip=/);
  });

  it('logs a request the client or the proxy gave up on, once, marked aborted', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const stuck = stuckHandler();
    await withServer(stuck.handle, async (url) => {
      const client = new AbortController();
      const pending = fetch(`${url}/api/slow?token=secret`, { signal: client.signal }).catch(
        () => undefined,
      );
      const closed = once(await stuck.response, 'close');
      client.abort(); // the proxy in front timed out (504), or the user left
      await Promise.all([pending, closed]);
    });
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toMatch(/^GET \/api\/slow - [\d.]+ms aborted ip=/);
  });

  it('keeps the status of a response cut after its headers were sent', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const streaming = stuckHandler((res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).write('first rows');
    });
    await withServer(streaming.handle, async (url) => {
      const client = new AbortController();
      const answer = await fetch(`${url}/api/export`, { signal: client.signal });
      const closed = once(await streaming.response, 'close');
      client.abort();
      await Promise.all([answer.text().catch(() => undefined), closed]);
    });
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toMatch(/^GET \/api\/export 200 [\d.]+ms aborted /);
  });

  it('logs the requests a shutdown cuts, marked aborted', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const stuck = stuckHandler();
    await withServer(stuck.handle, async (url, server) => {
      const pending = fetch(`${url}/api/slow`).catch(() => undefined);
      const closed = once(await stuck.response, 'close');
      // What GracefulShutdown does once the drain timeout has passed.
      server.closeAllConnections();
      await Promise.all([pending, closed]);
    });
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toMatch(/^GET \/api\/slow - [\d.]+ms aborted /);
  });
});

describe('pathOf', () => {
  it('drops the query string', () => {
    expect(pathOf({ originalUrl: '/a/b?c=d' } as Request)).toBe('/a/b');
    expect(pathOf({ originalUrl: '/a' } as Request)).toBe('/a');
  });
});

describe('clientIp', () => {
  it('gives IPv4 clients one form, whatever the socket', () => {
    expect(clientIp({ ip: '::ffff:198.51.100.4' } as Request)).toBe('198.51.100.4');
    expect(clientIp({ ip: '198.51.100.4' } as Request)).toBe('198.51.100.4');
    expect(clientIp({ ip: '2001:db8::1' } as Request)).toBe('2001:db8::1');
    expect(clientIp({} as Request)).toBe('unknown');
  });
});

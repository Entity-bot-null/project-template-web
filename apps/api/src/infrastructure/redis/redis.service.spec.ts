import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { ErrorReply, TimeoutError } from '@redis/client';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { currentRequestId, runWithRequestContext } from '../../observability/request-context.js';
import { reconnectDelay } from './redis.client.js';
import {
  RedisService,
  RedisUnavailableError,
  STALL_COOL_OFF_MS,
  STALL_THRESHOLD,
} from './redis.service.js';
import type { RedisClient, RedisOptions } from './redis.types.js';

class FakeClient extends EventEmitter {
  isReady = false;
  connect = vi.fn(() => new Promise<unknown>(() => undefined));
  close = vi.fn(() => Promise.resolve());
  destroy = vi.fn();
  ping = vi.fn(() => Promise.resolve('PONG'));
  get = vi.fn();
  set = vi.fn();
  del = vi.fn();
  incr = vi.fn();
  eval = vi.fn();

  becomeReady() {
    this.isReady = true;
    this.emit('ready');
  }

  drop(error = new Error('ECONNREFUSED')) {
    this.isReady = false;
    this.emit('error', error);
  }
}

const options = (overrides: Partial<RedisOptions> = {}): RedisOptions => ({
  url: 'redis://:pw@cache.internal:6379',
  keyPrefix: 'app:',
  required: false,
  commandTimeoutMs: 500,
  production: false,
  ...overrides,
});

function serviceWith(overrides: Partial<RedisOptions> = {}) {
  const client = new FakeClient();
  const factory = vi.fn(() => client as unknown as RedisClient);
  const service = new RedisService(options(overrides), factory);
  return { service, client, factory };
}

let log: MockInstance<Logger['log']>;
let warn: MockInstance<Logger['warn']>;
beforeEach(() => {
  log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RedisService', () => {
  it('is disabled without REDIS_URL: nothing connects, commands fail as "not configured"', async () => {
    const { service, factory } = serviceWith({ url: undefined });
    service.onModuleInit();
    expect(factory).not.toHaveBeenCalled();
    expect(service.status).toBe('disabled');
    await expect(service.health()).resolves.toBe('disabled');
    await expect(service.run((redis) => redis.ping())).rejects.toThrow('not configured');
  });

  it('never makes the boot wait for Redis', () => {
    const { service, client } = serviceWith();
    // connect() never settles in this fake, like an unreachable host.
    service.onModuleInit();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(service.status).toBe('connecting');
  });

  it('runs commands once connected, and fails fast while it is not', async () => {
    const { service, client } = serviceWith();
    service.onModuleInit();
    await expect(service.run((redis) => redis.ping())).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    client.becomeReady();
    await expect(service.run((redis) => redis.ping())).resolves.toBe('PONG');
    expect(service.status).toBe('ready');
  });

  it('turns timeouts and transient replies into RedisUnavailableError, and lets bugs through', async () => {
    const { service, client } = serviceWith();
    service.onModuleInit();
    client.becomeReady();
    const timeout = Object.assign(new Error('Timeout'), { name: 'TimeoutError' });
    await expect(service.run(() => Promise.reject(timeout))).rejects.toMatchObject({
      name: 'RedisUnavailableError',
      cause: timeout,
    });
    const loading = new ErrorReply('LOADING Redis is loading the dataset in memory');
    await expect(service.run(() => Promise.reject(loading))).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    const wrongType = new ErrorReply('WRONGTYPE Operation against a key holding the wrong kind');
    await expect(service.run(() => Promise.reject(wrongType))).rejects.toBe(wrongType);
    // Outside the ACL (another key prefix, a command it does not list): the
    // adapters degrade, they do not fail the request.
    const refused = new ErrorReply(
      'NOPERM No permissions to access a key used as arguments of the command',
    );
    await expect(service.run(() => Promise.reject(refused))).rejects.toMatchObject({
      name: 'RedisUnavailableError',
      message: expect.stringContaining('NOPERM') as string,
    });
  });

  it('logs an outage once, however many reconnects fail, and its recovery', () => {
    const { service, client } = serviceWith();
    service.onModuleInit();
    client.becomeReady();
    client.drop();
    client.drop();
    client.drop();
    expect(service.status).toBe('unavailable');
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(':pw@');
    client.becomeReady();
    expect(log).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Redis connection restored after \d+s$/),
    );
  });

  it('keeps its status when an error comes without a disconnect, and still reports a later outage', () => {
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const { service, client } = serviceWith();
    service.onModuleInit();
    client.becomeReady();
    // node-redis emits 'error' on a live connection too: its keep-alive PING
    // answered BUSY (a long script), or a reply it could not decode.
    client.emit('error', new ErrorReply('BUSY Redis is busy running a script'));
    expect(client.isReady).toBe(true);
    expect(service.status).toBe('ready');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Redis unavailable'));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('BUSY'));

    client.drop();
    expect(service.status).toBe('unavailable');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Redis unavailable'));
    client.becomeReady();
    expect(log).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Redis connection restored after \d+s$/),
    );
  });

  it('reports health from a write of its own under the prefix, as the adapters write', async () => {
    const { service, client } = serviceWith();
    service.onModuleInit();
    client.becomeReady();
    await expect(service.health()).resolves.toBe('ok');
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("'SET'"), {
      keys: ['app:health'],
      arguments: ['1', '10000'],
    });
    client.eval.mockRejectedValueOnce(new Error('Timeout'));
    await expect(service.health()).resolves.toBe('unavailable');
    // PING answers where the ACL refuses the prefix: readiness must not.
    client.eval.mockRejectedValueOnce(new ErrorReply('NOPERM No permissions to access a key'));
    await expect(service.health()).resolves.toBe('unavailable');
  });

  it('warns in production about an unencrypted or password-less URL', () => {
    serviceWith({ url: 'redis://cache.internal:6379', production: true }).service.onModuleInit();
    const warnings = warn.mock.calls.map(([message]: unknown[]) => String(message));
    expect(warnings.some((message: string) => message.includes('not encrypted'))).toBe(true);
    expect(warnings.some((message: string) => message.includes('no password'))).toBe(true);
  });

  it('closes on shutdown, and destroys the connection when closing hangs', async () => {
    const { service, client } = serviceWith();
    service.onModuleInit();
    client.becomeReady();
    await service.onModuleDestroy();
    expect(client.close).toHaveBeenCalledOnce();
    expect(service.status).toBe('closed');

    vi.useFakeTimers();
    const hanging = serviceWith();
    hanging.service.onModuleInit();
    hanging.client.close.mockReturnValue(new Promise(() => undefined));
    const closing = hanging.service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(2_500);
    await closing;
    expect(hanging.client.destroy).toHaveBeenCalledOnce();
  });

  it('builds keys inside the application prefix', () => {
    expect(serviceWith().service.key('cache', 'users', '7')).toBe('app:cache:users:7');
  });
});

describe('RedisService when Redis stalls', () => {
  const never = () => new Promise<never>(() => undefined);

  function stalledService() {
    vi.useFakeTimers();
    const setup = serviceWith();
    setup.service.onModuleInit();
    setup.client.becomeReady();
    return setup;
  }

  /** One command that gets no reply: it fails at the 500 ms command timeout. */
  async function missReply(service: RedisService, client: FakeClient) {
    client.get.mockImplementationOnce(never);
    const failure = service.run((redis) => redis.get('k')).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    return failure;
  }

  it(`stops sending after ${String(STALL_THRESHOLD)} commands in a row got no reply, and says so once`, async () => {
    const { service, client } = stalledService();
    for (let i = 0; i < STALL_THRESHOLD; i += 1) {
      expect(await missReply(service, client)).toBeInstanceOf(RedisUnavailableError);
    }
    client.get.mockClear();
    await expect(service.run((redis) => redis.get('k'))).rejects.toThrow('not answering');
    await expect(service.health()).resolves.toBe('unavailable');
    expect(client.get).not.toHaveBeenCalled();
    expect(client.ping).not.toHaveBeenCalled();
    const stallWarnings = warn.mock.calls.filter(([message]) =>
      String(message).startsWith('Redis is not answering'),
    );
    expect(stallWarnings).toHaveLength(1);
    expect(String(stallWarnings[0]?.[0])).not.toContain(':pw@');
  });

  it("counts node-redis's own timeout, and resets the count on any reply, error replies included", async () => {
    const { service, client } = stalledService();
    client.get.mockRejectedValueOnce(new TimeoutError());
    await expect(service.run((redis) => redis.get('k'))).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    await missReply(service, client);
    const wrongType = new ErrorReply('WRONGTYPE Operation against a key holding the wrong kind');
    client.get.mockRejectedValueOnce(wrongType);
    await expect(service.run((redis) => redis.get('k'))).rejects.toBe(wrongType);
    // Two more misses are not three in a row: commands are still sent.
    await missReply(service, client);
    await missReply(service, client);
    client.get.mockResolvedValueOnce('v');
    await expect(service.run((redis) => redis.get('k'))).resolves.toBe('v');
  });

  it('probes with one PING per cool-off until it gets a reply in time', async () => {
    const { service, client } = stalledService();
    for (let i = 0; i < STALL_THRESHOLD; i += 1) await missReply(service, client);
    client.ping.mockImplementation(never);
    await vi.advanceTimersByTimeAsync(STALL_COOL_OFF_MS + 500);
    expect(client.ping).toHaveBeenCalledOnce();
    await expect(service.run((redis) => redis.get('k'))).rejects.toThrow('not answering');
    await vi.advanceTimersByTimeAsync(STALL_COOL_OFF_MS + 500);
    expect(client.ping).toHaveBeenCalledTimes(2);

    client.ping.mockResolvedValue('PONG');
    await vi.advanceTimersByTimeAsync(STALL_COOL_OFF_MS);
    expect(client.ping).toHaveBeenCalledTimes(3);
    client.get.mockResolvedValueOnce('v');
    await expect(service.run((redis) => redis.get('k'))).resolves.toBe('v');
    expect(log).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Redis answering again after \d+s$/),
    );
    // Over: no more probes.
    await vi.advanceTimersByTimeAsync(STALL_COOL_OFF_MS * 3);
    expect(client.ping).toHaveBeenCalledTimes(3);
  });

  it('probes outside the request that started the stall', async () => {
    const { service, client } = stalledService();
    await runWithRequestContext({ requestId: 'req-stall' }, async () => {
      for (let i = 0; i < STALL_THRESHOLD; i += 1) await missReply(service, client);
    });
    let probedFor: string | undefined = 'not probed';
    client.ping.mockImplementation(() => {
      probedFor = currentRequestId();
      return Promise.resolve('PONG');
    });
    await vi.advanceTimersByTimeAsync(STALL_COOL_OFF_MS);
    expect(probedFor).toBeUndefined();
  });

  it('ends a stall on reconnect, and stops probing on shutdown', async () => {
    const { service, client } = stalledService();
    for (let i = 0; i < STALL_THRESHOLD; i += 1) await missReply(service, client);
    client.drop();
    client.becomeReady();
    client.get.mockResolvedValueOnce('v');
    await expect(service.run((redis) => redis.get('k'))).resolves.toBe('v');

    for (let i = 0; i < STALL_THRESHOLD; i += 1) await missReply(service, client);
    await service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(STALL_COOL_OFF_MS * 3);
    expect(client.ping).not.toHaveBeenCalled();
  });
});

describe('reconnectDelay', () => {
  it('backs off exponentially up to 5 s, with jitter', () => {
    const noJitter = () => 0;
    expect([0, 1, 2, 3].map((retry) => reconnectDelay(retry, noJitter))).toEqual([
      100, 200, 400, 800,
    ]);
    expect(reconnectDelay(50, noJitter)).toBe(5_000);
    expect(reconnectDelay(0, () => 0.99)).toBe(199);
  });
});

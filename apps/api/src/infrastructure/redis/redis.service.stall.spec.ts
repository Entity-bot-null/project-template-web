import { createServer, type Server, type Socket } from 'node:net';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisRateLimitStore } from '../rate-limit/rate-limit.store.js';
import { createRedisClient } from './redis.client.js';
import { RedisService, RedisUnavailableError } from './redis.service.js';

// The real RedisService and the real node-redis client against a minimal
// RESP server on loopback that can stop answering while staying connected
// (a paused Redis, a long script, a blackholed route) or refuse writes. The
// fake client of redis.service.spec.ts cannot stall, which is how these bugs
// passed every gate.

class FakeRedis {
  replyFor: Record<string, string> = {};
  /** Commands received, by name. */
  readonly received: string[] = [];
  private paused = false;
  // Replies held while paused, sent in order on resume: a paused Redis (or
  // one stuck in a script) answers every command it got once it moves on.
  private readonly held: { socket: Socket; reply: string }[] = [];
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;

  get stalled(): boolean {
    return this.paused;
  }

  set stalled(value: boolean) {
    this.paused = value;
    if (value) return;
    for (const { socket, reply } of this.held.splice(0)) {
      if (!socket.destroyed) socket.write(reply);
    }
  }

  async start(): Promise<number> {
    const server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          const parsed = parseCommand(buffer);
          if (parsed === undefined) break;
          buffer = buffer.slice(parsed.length);
          const name = parsed.args[0]?.toUpperCase() ?? '';
          this.received.push(name);
          const reply = this.replyFor[name] ?? defaultReply(name);
          if (this.paused) this.held.push({ socket, reply });
          else socket.write(reply);
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return address.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }
}

function defaultReply(name: string): string {
  if (name === 'PING') return '+PONG\r\n';
  if (name === 'GET') return '$-1\r\n';
  return '+OK\r\n';
}

/** One RESP array of bulk strings at the start of `input`, if complete. */
function parseCommand(input: string): { args: string[]; length: number } | undefined {
  if (!input.startsWith('*')) return undefined;
  let index = input.indexOf('\r\n');
  if (index < 0) return undefined;
  const count = Number(input.slice(1, index));
  let offset = index + 2;
  const args: string[] = [];
  for (let i = 0; i < count; i += 1) {
    index = input.indexOf('\r\n', offset);
    if (index < 0) return undefined;
    const size = Number(input.slice(offset + 1, index));
    const start = index + 2;
    if (input.length < start + size + 2) return undefined;
    args.push(input.slice(start, start + size));
    offset = start + size + 2;
  }
  return { args, length: offset };
}

const pendingAfter = (ms: number) =>
  new Promise<'still pending'>((resolve) => {
    setTimeout(() => {
      resolve('still pending');
    }, ms);
  });

let fake: FakeRedis;

async function connectedService(
  commandTimeoutMs = 200,
  stallCoolOffMs = 300,
): Promise<RedisService> {
  const port = await fake.start();
  const service = new RedisService(
    {
      url: `redis://127.0.0.1:${String(port)}`,
      keyPrefix: 'stall-spec:',
      required: false,
      commandTimeoutMs,
      stallCoolOffMs,
      production: false,
    },
    createRedisClient,
  );
  service.onModuleInit();
  for (let i = 0; i < 100 && service.status !== 'ready'; i += 1) await pendingAfter(20);
  expect(service.status).toBe('ready');
  return service;
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  fake = new FakeRedis();
});

afterEach(async () => {
  await fake.stop();
});

describe('RedisService against a Redis that stops answering', () => {
  it('fails a command with RedisUnavailableError within REDIS_COMMAND_TIMEOUT_MS', async () => {
    const service = await connectedService(200);
    fake.stalled = true;
    const started = Date.now();
    const outcome = await Promise.race([
      service
        .run((redis) => redis.get(service.key('x')))
        .then(
          () => 'resolved',
          (error: unknown) =>
            error instanceof RedisUnavailableError ? 'unavailable' : String(error),
        ),
      pendingAfter(1_500),
    ]);
    expect(outcome).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(1_000);
    fake.stalled = false;
    await service.onModuleDestroy();
  });

  it('answers the readiness probe as unavailable instead of hanging it', async () => {
    const service = await connectedService(200);
    fake.stalled = true;
    expect(await Promise.race([service.health(), pendingAfter(1_500)])).toBe('unavailable');
    fake.stalled = false;
    await service.onModuleDestroy();
  });

  it('keeps rate limiting on the per-instance fallback instead of hanging the request', async () => {
    const service = await connectedService(200);
    const store = new RedisRateLimitStore(service);
    fake.stalled = true;
    const outcome = await Promise.race([
      store.increment('client-ip', 60_000, 10, 60_000, 'default').then(
        (record) => `limited: ${String(record.totalHits)} hit`,
        (error: unknown) => `threw: ${String(error)}`,
      ),
      pendingAfter(1_500),
    ]);
    expect(outcome).toBe('limited: 1 hit');
    store.onApplicationShutdown();
    fake.stalled = false;
    await service.onModuleDestroy();
  });

  it('degrades, and says so in readiness, when the ACL refuses the prefix (NOPERM)', async () => {
    const service = await connectedService(200);
    // Another REDIS_KEY_PREFIX than the ACL's: every key and script refused,
    // PING still answered.
    fake.replyFor.EVAL =
      '-NOPERM No permissions to access a key used as arguments of the command\r\n';
    fake.replyFor.SET = fake.replyFor.EVAL;
    await expect(service.run((redis) => redis.ping())).resolves.toBe('PONG');
    await expect(service.health()).resolves.toBe('unavailable');
    // The rate limiter counts per instance instead of failing every request.
    const store = new RedisRateLimitStore(service);
    await expect(
      store.increment('client-ip', 60_000, 10, 60_000, 'default'),
    ).resolves.toMatchObject({ totalHits: 1, isBlocked: false });
    store.onApplicationShutdown();
    await service.onModuleDestroy();
  });

  it('shuts down without throwing while a command is still waiting for its reply', async () => {
    const service = await connectedService(200);
    fake.stalled = true;
    void service.run((redis) => redis.get(service.key('pending'))).catch(() => undefined);
    await pendingAfter(50);
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  }, 10_000);
});

describe('RedisService against a Redis that stays stalled', () => {
  const outcomeOf = (pending: Promise<unknown>) =>
    pending.then(
      () => 'answered',
      (error: unknown) => (error instanceof RedisUnavailableError ? 'unavailable' : String(error)),
    );

  it('stops waiting on it after a few timeouts in a row, then a probe brings it back', async () => {
    const service = await connectedService(200, 300);
    const get = () => outcomeOf(service.run((redis) => redis.get(service.key('x'))));
    fake.stalled = true;
    // The first requests pay the command timeout...
    for (let i = 0; i < 3; i += 1) expect(await get()).toBe('unavailable');
    // ...the next ones fail at once instead of each waiting 200 ms, and are
    // not even sent to the stalled server.
    const sentBefore = fake.received.length;
    const started = performance.now();
    for (let i = 0; i < 5; i += 1) expect(await get()).toBe('unavailable');
    expect(performance.now() - started).toBeLessThan(100);
    expect(fake.received.length).toBe(sentBefore);
    await expect(service.health()).resolves.toBe('unavailable');

    // Redis answers again: a PING probe gets a reply, and commands flow.
    fake.stalled = false;
    await vi.waitFor(
      async () => {
        expect(await get()).toBe('answered');
      },
      { timeout: 3_000, interval: 50 },
    );
    expect(fake.received).toContain('PING');
    await expect(service.health()).resolves.toBe('ok');
    await service.onModuleDestroy();
  });

  it('keeps failing fast while every probe times out, without piling up commands', async () => {
    const service = await connectedService(100, 200);
    fake.stalled = true;
    for (let i = 0; i < 3; i += 1) {
      await service.run((redis) => redis.get(service.key('x'))).catch(() => undefined);
    }
    // Several cool-off periods: each one ends with a single PING, never a
    // flood of requests.
    await pendingAfter(1_000);
    const pings = fake.received.filter((name) => name === 'PING').length;
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(pings).toBeLessThanOrEqual(5);
    await expect(service.health()).resolves.toBe('unavailable');
    fake.stalled = false;
    await service.onModuleDestroy();
  });
});

describe('RedisService against a Redis that refuses writes', () => {
  it.each([
    [
      'MISCONF (cannot persist: disk full)',
      '-MISCONF Errors writing to the AOF file: No space left on device\r\n',
    ],
    ['OOM (maxmemory reached)', "-OOM command not allowed when used memory > 'maxmemory'.\r\n"],
  ])('rate limiting falls back to per-instance counters on %s', async (_label, reply) => {
    const service = await connectedService(200);
    fake.replyFor = { EVAL: reply, EVALSHA: reply };
    const store = new RedisRateLimitStore(service);
    const record = await store.increment('client-ip', 60_000, 10, 60_000, 'default');
    expect(record.totalHits).toBe(1);
    store.onApplicationShutdown();
    await service.onModuleDestroy();
  });
});

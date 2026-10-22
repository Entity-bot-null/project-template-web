import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disabledErrorTracker, setErrorTracker } from '../../observability/error-tracker.js';
import type { MailOutboxService } from './mail-outbox.service.js';
import { MailWorker } from './mail-worker.service.js';
import { MAIL_LEASE_MS } from './mail.constants.js';
import type { MailStore, OutboxStats } from './mail.store.js';
import type { MailTransport } from './mail.transport.js';
import type { ClaimedMessage, MailOptions, OutgoingMail } from './mail.types.js';
import type { MailTemplate, MailTemplates } from './templates/registry.js';

const metrics = vi.hoisted(() => ({
  recordMailDelivery: vi.fn(),
  recordMailLatency: vi.fn(),
  observeMailOutbox: vi.fn(),
}));
vi.mock('../../observability/metrics.js', () => metrics);

const options: MailOptions = {
  smtpUrl: 'smtp://localhost:1035',
  from: { name: 'Acme', address: 'no-reply@acme.test' },
  appOrigin: 'https://app.acme.test',
  appBasePath: '/app',
  maxAttempts: 3,
  dailyLimitPerAddress: 10,
  production: false,
  recipientKey: Buffer.alloc(32),
};

let nextId = 0;
function message(overrides: Partial<ClaimedMessage> = {}): ClaimedMessage {
  nextId += 1;
  return {
    id: `m${String(nextId)}`,
    kind: 'test',
    recipient: 'ada@example.test',
    userId: null,
    payload: {},
    attempts: 1,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(Date.now() - 2_000),
    requestId: null,
    ...overrides,
  };
}

const smtpError = (code: string, responseCode?: number) =>
  Object.assign(new Error('refused'), { code, responseCode });

interface Setup {
  queue?: ClaimedMessage[];
  compose?: MailTemplate['compose'];
  send?: MailTransport['send'];
  enabled?: boolean;
  workerOptions?: MailOptions;
  stats?: OutboxStats;
}

function setup({
  queue = [],
  compose = () => Promise.resolve({ subject: 's', text: 't', html: 'h' }),
  send = () => Promise.resolve(),
  enabled = true,
  workerOptions = options,
  stats = { waiting: 0, oldestAgeSeconds: 0 },
}: Setup = {}) {
  const store = {
    claim: vi.fn(() => Promise.resolve(queue.shift())),
    inTransaction: vi.fn((work: (tx: unknown) => Promise<unknown>) => work('tx')),
    markSent: vi.fn(() => Promise.resolve(true)),
    renewLease: vi.fn(() => Promise.resolve(true)),
    reschedule: vi.fn(() => Promise.resolve(true)),
    markFailed: vi.fn(() => Promise.resolve(true)),
    markExpired: vi.fn(() => Promise.resolve(true)),
    stats: vi.fn(() => Promise.resolve(stats)),
    sweep: vi.fn(() => Promise.resolve({ deleted: 0, cleared: 0, expired: 0 })),
  };
  let queuedListener: (() => void) | undefined;
  const outbox = {
    enabled,
    onQueued: (listener: () => void) => {
      queuedListener = listener;
    },
  };
  const transport = { send: vi.fn(send), close: vi.fn() };
  const templates = {
    test: { limited: false, ttlMs: 60_000, compose: vi.fn(compose) },
  } as unknown as MailTemplates;
  const worker = new MailWorker(
    store as unknown as MailStore,
    outbox as unknown as MailOutboxService,
    workerOptions,
    () => transport,
    templates,
  );
  return { worker, store, transport, templates, queue, notify: () => queuedListener?.() };
}

/** Starts the worker and waits for what it did at once (stats, sweep, a drain). */
async function started(context: ReturnType<typeof setup>) {
  context.worker.onApplicationBootstrap();
  await vi.waitFor(() => {
    expect(context.store.sweep).toHaveBeenCalled();
  });
  await context.worker.idle();
  return context;
}

const logs = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
let workers: MailWorker[] = [];

beforeEach(() => {
  logs.log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  logs.warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  logs.error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  metrics.recordMailDelivery.mockClear();
  metrics.recordMailLatency.mockClear();
});
afterEach(async () => {
  for (const worker of workers) await worker.onModuleDestroy();
  workers = [];
  setErrorTracker(disabledErrorTracker);
});

function tracked(context: ReturnType<typeof setup>) {
  workers.push(context.worker);
  return context;
}

describe('MailWorker', () => {
  it('stays off when email is off: no transport, no claims, readiness says disabled; retention still runs', () => {
    const context = tracked(setup({ enabled: false }));
    context.worker.onApplicationBootstrap();
    context.worker.wake();
    expect(context.store.claim).not.toHaveBeenCalled();
    expect(context.worker.health()).toBe('disabled');
    // Messages left from when email was on still hold addresses.
    expect(context.store.sweep).toHaveBeenCalledOnce();
  });

  it('warns at boot in production about a loopback origin or SMTP server (a copied development setting)', () => {
    const warned = tracked(
      setup({
        workerOptions: {
          ...options,
          production: true,
          smtpUrl: 'smtp://localhost:1035',
          appOrigin: 'http://localhost:5173',
        },
      }),
    );
    warned.worker.onApplicationBootstrap();
    expect(logs.warn).toHaveBeenCalledWith(
      expect.stringContaining('APP_ORIGIN is a loopback origin'),
    );
    expect(logs.warn).toHaveBeenCalledWith(
      expect.stringContaining('MAIL_SMTP_URL is a server on this machine'),
    );
    logs.warn.mockClear();
    const real = tracked(
      setup({
        workerOptions: {
          ...options,
          production: true,
          smtpUrl: 'smtps://smtp.acme.test',
          appOrigin: 'https://app.acme.test',
        },
      }),
    );
    real.worker.onApplicationBootstrap();
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it("points a message's links at the web app: APP_ORIGIN and APP_BASE_PATH", async () => {
    const compose = vi.fn(() => Promise.resolve({ subject: 's', text: 't', html: 'h' }));
    await started(tracked(setup({ queue: [message()], compose })));
    expect(compose).toHaveBeenCalledWith(
      expect.objectContaining({ product: 'Acme', appUrl: 'https://app.acme.test/app' }),
    );
    const atRoot = vi.fn(() => Promise.resolve({ subject: 's', text: 't', html: 'h' }));
    await started(
      tracked(
        setup({
          queue: [message()],
          compose: atRoot,
          workerOptions: { ...options, appBasePath: '/' },
        }),
      ),
    );
    expect(atRoot).toHaveBeenCalledWith(
      expect.objectContaining({ appUrl: 'https://app.acme.test' }),
    );
  });

  it('renders a due message in a short transaction, sends it, records it as sent', async () => {
    const queued = message();
    const context = tracked(setup({ queue: [queued] }));
    await started(context);
    expect(context.store.inTransaction).toHaveBeenCalledOnce();
    expect(context.transport.send).toHaveBeenCalledWith({
      id: queued.id,
      to: 'ada@example.test',
      subject: 's',
      text: 't',
      html: 'h',
    } satisfies OutgoingMail);
    expect(context.store.markSent).toHaveBeenCalledWith(queued);
    expect(metrics.recordMailDelivery).toHaveBeenCalledWith('test', 'sent', expect.any(Number));
    expect(metrics.recordMailLatency).toHaveBeenCalledWith('test', expect.any(Number));
    expect(context.worker.health()).toBe('ok');
    expect(metrics.observeMailOutbox).toHaveBeenCalled();
  });

  it('retries a transient failure later, and reads as degraded until a delivery succeeds', async () => {
    const context = tracked(
      setup({
        queue: [message()],
        send: () => Promise.reject(smtpError('EENVELOPE', 451)),
      }),
    );
    await started(context);
    expect(context.store.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1 }),
      expect.any(Number),
      'smtp_4xx_451',
    );
    const [, delay] = context.store.reschedule.mock.calls[0] as unknown as [unknown, number];
    expect(delay).toBeGreaterThanOrEqual(15_000);
    expect(delay).toBeLessThanOrEqual(30_000);
    expect(metrics.recordMailDelivery).toHaveBeenCalledWith('test', 'retry', expect.any(Number));
    expect(context.worker.health()).toBe('degraded');
    expect(context.worker.health(Date.now() + 16 * 60_000)).toBe('ok');

    context.transport.send.mockResolvedValueOnce(undefined);
    context.queue.push(message());
    context.worker.wake();
    await context.worker.idle();
    expect(context.worker.health()).toBe('ok');
  });

  it('gives up at once on a permanent refusal, which says nothing about the server', async () => {
    const context = tracked(
      setup({ queue: [message()], send: () => Promise.reject(smtpError('EENVELOPE', 550)) }),
    );
    await started(context);
    expect(context.store.markFailed).toHaveBeenCalledWith(expect.anything(), 'smtp_5xx_550');
    expect(context.store.reschedule).not.toHaveBeenCalled();
    expect(metrics.recordMailDelivery).toHaveBeenCalledWith('test', 'failed', expect.any(Number));
    expect(context.worker.health()).toBe('ok');
    expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('mail status'));
  });

  it('gives up after the last allowed attempt', async () => {
    const context = tracked(
      setup({
        queue: [message({ attempts: 3 })],
        send: () => Promise.reject(smtpError('ESOCKET')),
      }),
    );
    await started(context);
    expect(context.store.markFailed).toHaveBeenCalledWith(expect.anything(), 'connection');
    expect(metrics.recordMailDelivery).toHaveBeenCalledWith('test', 'failed', expect.any(Number));
    expect(metrics.recordMailDelivery).not.toHaveBeenCalledWith('test', 'retry', expect.anything());
  });

  it('fails a message whose worker keeps dying with it, without sending it again', async () => {
    const context = tracked(setup({ queue: [message({ attempts: 4 })] }));
    await started(context);
    expect(context.transport.send).not.toHaveBeenCalled();
    expect(context.store.markFailed).toHaveBeenCalledWith(expect.anything(), 'attempts_exhausted');
    // Counted like any failure, or the alert on failed messages would miss it.
    expect(metrics.recordMailDelivery).toHaveBeenCalledWith('test', 'failed', undefined);
  });

  it('drops a message past its expiry instead of sending it late', async () => {
    const context = tracked(setup({ queue: [message({ expiresAt: new Date(Date.now() - 1) })] }));
    await started(context);
    expect(context.transport.send).not.toHaveBeenCalled();
    expect(context.store.markExpired).toHaveBeenCalledWith(expect.anything(), 'expired');
    expect(metrics.recordMailDelivery).toHaveBeenCalledWith('test', 'expired');
  });

  it('drops a message its template says no longer applies', async () => {
    const context = tracked(setup({ queue: [message()], compose: () => Promise.resolve(null) }));
    await started(context);
    expect(context.transport.send).not.toHaveBeenCalled();
    expect(context.store.markExpired).toHaveBeenCalledWith(expect.anything(), 'not_applicable');
  });

  it('retries a message it could not render (the database blinked), without sending anything', async () => {
    const context = tracked(
      setup({ queue: [message()], compose: () => Promise.reject(new Error('db down')) }),
    );
    await started(context);
    expect(context.transport.send).not.toHaveBeenCalled();
    expect(metrics.recordMailDelivery).toHaveBeenCalledWith('test', 'retry', undefined);
    expect(context.store.reschedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      'render',
    );
  });

  it('never builds a link without the configured public origin', async () => {
    const context = tracked(
      setup({ queue: [message()], workerOptions: { ...options, appOrigin: undefined } }),
    );
    await started(context);
    expect(context.transport.send).not.toHaveBeenCalled();
    expect(context.store.reschedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      'render',
    );
  });

  it('reports a refused configuration to the error tracker as a failing dependency', async () => {
    const capture = vi.fn();
    setErrorTracker({ ...disabledErrorTracker, capture });
    const context = tracked(
      setup({ queue: [message()], send: () => Promise.reject(smtpError('EAUTH', 535)) }),
    );
    await started(context);
    expect(capture).toHaveBeenCalledWith(expect.any(Error), {
      level: 'error',
      origin: 'dependency',
      dependency: 'smtp',
    });
    expect(context.store.reschedule).toHaveBeenCalled();
    expect(context.worker.health()).toBe('degraded');
  });

  it('renews its lease while a slow exchange goes on, and stops once it ends', async () => {
    let answer: () => void = () => undefined;
    const exchange = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const queued = message();
    const context = tracked(setup({ send: () => exchange }));
    await started(context);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      context.queue.push(queued);
      const run = context.worker.runOnce();
      await vi.waitFor(() => {
        expect(context.transport.send).toHaveBeenCalled();
      });
      // Every step within its own timeout, the whole past the lease.
      vi.advanceTimersByTime(MAIL_LEASE_MS * 2);
      expect(context.store.renewLease).toHaveBeenCalledTimes(6);
      expect(context.store.renewLease).toHaveBeenCalledWith(queued);
      answer();
      await run;
      expect(context.store.markSent).toHaveBeenCalledWith(queued);
      vi.advanceTimersByTime(MAIL_LEASE_MS);
      expect(context.store.renewLease).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns when its lease ran out before it recorded a delivery (another worker may resend)', async () => {
    const context = tracked(setup({ queue: [message()] }));
    context.store.markSent.mockResolvedValueOnce(false);
    await started(context);
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('lease had run out'));
  });

  it('reads as degraded while the oldest waiting message is older than 15 minutes', async () => {
    const context = tracked(setup({ stats: { waiting: 3, oldestAgeSeconds: 16 * 60 } }));
    await started(context);
    await vi.waitFor(() => {
      expect(context.worker.health()).toBe('degraded');
    });
  });

  it('drains again when woken during a drain, and goes on past a database error', async () => {
    const context = tracked(setup());
    await started(context);
    context.store.claim.mockRejectedValueOnce(new Error('connection lost'));
    context.worker.wake();
    context.queue.push(message());
    context.worker.wake();
    await context.worker.idle();
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
    expect(context.transport.send).toHaveBeenCalledOnce();
  });

  it('runs the queue on demand, after a drain already in progress', async () => {
    const context = tracked(setup());
    await started(context);
    context.queue.push(message(), message());
    await context.worker.runOnce();
    expect(context.transport.send).toHaveBeenCalledTimes(2);
    await context.worker.onModuleDestroy();
    context.queue.push(message());
    await context.worker.runOnce();
    expect(context.transport.send).toHaveBeenCalledTimes(2);
  });

  it('is woken by a commit that queued a message', async () => {
    const context = tracked(setup());
    await started(context);
    context.queue.push(message());
    context.notify();
    await context.worker.idle();
    expect(context.transport.send).toHaveBeenCalledOnce();
  });

  it('logs and carries on when the statistics or the retention sweep fail', async () => {
    const context = tracked(setup());
    context.store.stats.mockRejectedValueOnce(new Error('stats failed'));
    context.store.sweep.mockRejectedValueOnce(new Error('sweep failed'));
    await started(context);
    await vi.waitFor(() => {
      expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('sweep failed'));
    });
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('stats failed'));
  });

  it('logs what the retention sweep removed', async () => {
    const context = tracked(setup());
    context.store.sweep.mockResolvedValueOnce({ deleted: 2, cleared: 1, expired: 4 });
    await started(context);
    await vi.waitFor(() => {
      expect(logs.log).toHaveBeenCalledWith(
        expect.stringContaining('deleted 2 old messages, cleared 1 addresses, dropped 4 stale'),
      );
    });
  });

  it('on shutdown, stops claiming and waits for the message being sent, then closes', async () => {
    let finish: () => void = () => undefined;
    const context = setup({
      send: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    await started(context);
    context.queue.push(message(), message());
    context.worker.wake();
    await vi.waitFor(() => {
      expect(context.transport.send).toHaveBeenCalledOnce();
    });
    const stopping = context.worker.onModuleDestroy();
    finish();
    await stopping;
    expect(context.store.markSent).toHaveBeenCalledOnce();
    expect(context.transport.close).toHaveBeenCalledOnce();
    expect(context.queue).toHaveLength(1);
    context.worker.wake();
    expect(context.store.claim).toHaveBeenCalledTimes(2);
  });
});

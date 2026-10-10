import type { Server } from 'node:http';
import {
  Global,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { errorTracker } from '../observability/error-tracker.js';
import { telemetry } from '../observability/telemetry.js';

/** How long requests in flight get to finish once SIGTERM arrives. */
export const DRAIN_TIMEOUT_MS = 10_000;
const FLUSH_TIMEOUT_MS = 2_000;

/** Set once shutdown begins; readiness then fails, so no new traffic is routed here. */
@Injectable()
export class ShutdownState {
  private started = false;

  get shuttingDown(): boolean {
    return this.started;
  }

  begin(): void {
    this.started = true;
  }
}

@Global()
@Module({ providers: [ShutdownState], exports: [ShutdownState] })
export class ShutdownStateModule {}

// The shutdown sequence (docs/observability.md#graceful-shutdown). Nest runs
// module destroy hooks from the root module down, before it closes the HTTP
// server; this provider lives in the root module, so it runs first:
//   1. readiness starts failing and the server stops accepting connections;
//   2. requests in flight finish (at most DRAIN_TIMEOUT_MS);
//   3. Nest closes the modules: database pool, Redis connection, timers;
//   4. last, buffered spans, metrics and error reports are flushed.
@Injectable()
export class GracefulShutdown implements OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger('Shutdown');

  constructor(
    private readonly state: ShutdownState,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.state.begin();
    const server = this.adapterHost.httpAdapter.getHttpServer() as Server | undefined;
    if (server?.listening !== true) return;
    this.logger.log('Shutting down: refusing new connections, finishing requests in flight');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.logger.warn(`Requests still running after ${DRAIN_TIMEOUT_MS} ms: closing them`);
        server.closeAllConnections();
        resolve();
      }, DRAIN_TIMEOUT_MS);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      server.closeIdleConnections();
    });
    this.logger.log('HTTP server closed');
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    await Promise.allSettled([telemetry().shutdown(), errorTracker().close(FLUSH_TIMEOUT_MS)]);
    this.logger.log(`Shutdown complete${signal === undefined ? '' : ` (${signal})`}`);
  }
}

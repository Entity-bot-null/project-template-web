import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { withDeadline } from '../common/utils/deadline.js';
import { type RedisHealth, RedisService } from '../infrastructure/redis/redis.service.js';
import { ShutdownState } from '../lifecycle/shutdown.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Readiness answers within this, whatever its dependencies do. A database or
 * a Redis that stays connected but stops answering (a failover, a paused
 * server, a blackholed route) fails the check at the deadline instead of
 * hanging the probe until the orchestrator gives up without saying why.
 */
export const READINESS_TIMEOUT_MS = 2_500;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly shutdown: ShutdownState,
  ) {}

  /** The process is up and serving requests. Checks nothing else on purpose. */
  live() {
    return { status: 'ok' as const, uptime: Math.round(process.uptime()) };
  }

  /**
   * Every hard dependency is reachable; 503 otherwise. The database always is
   * one; Redis only with REDIS_REQUIRED=true. An optional Redis that is down
   * reports "degraded" with 200: the instance still serves (features degrade,
   * docs/architecture.md#degradation), and pulling every instance out of the
   * load balancer for it would turn a degraded service into an outage. Both
   * are checked at once, each within READINESS_TIMEOUT_MS.
   */
  async ready() {
    if (this.shutdown.shuttingDown) throw new ServiceUnavailableException('Shutting down');
    const [databaseFailure, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    if (databaseFailure !== undefined) {
      this.logger.warn(`Readiness: database unreachable (${databaseFailure})`);
      throw new ServiceUnavailableException('Database unreachable');
    }
    if (redis === 'unavailable' && this.redis.required) {
      this.logger.warn('Readiness: Redis unreachable (REDIS_REQUIRED=true)');
      throw new ServiceUnavailableException('Redis unreachable');
    }
    return {
      status: redis === 'unavailable' ? ('degraded' as const) : ('ok' as const),
      checks: { database: 'ok' as const, redis },
    };
  }

  /** Why the database failed the check; undefined when it answered. */
  private async checkDatabase(): Promise<string | undefined> {
    try {
      await withDeadline(this.prisma.$queryRaw`SELECT 1`, READINESS_TIMEOUT_MS);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private async checkRedis(): Promise<RedisHealth> {
    try {
      return await withDeadline(this.redis.health(), READINESS_TIMEOUT_MS);
    } catch {
      return 'unavailable';
    }
  }
}

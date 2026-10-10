import { randomUUID } from 'node:crypto';
import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { recordDegradation } from '../../observability/metrics.js';
import { RedisService, RedisUnavailableError } from '../redis/redis.service.js';

// Where the rate limiter keeps its counters (docs/security.md#rate-limiting).
// The guard, the limits and the routes do not change with the store: only
// RATE_LIMIT_STORE does.
//
//   memory  one instance: counters live in the process (the default, and the
//           behavior the template always had).
//   redis   several instances: counters are shared, so a client cannot
//           multiply its allowance by the number of instances.
export type RateLimitStore = ThrottlerStorage;
export type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/** Provider token of the active store. */
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

/** The throttler's own in-memory store: a sliding log of hits per key, with blocking. */
export class InMemoryRateLimitStore extends ThrottlerStorageService implements RateLimitStore {}

// The same algorithm as the in-memory store, atomically in Redis, so both
// stores answer the same requests the same way:
//   - each hit is a sorted-set member scored by its expiry; expired hits are
//     dropped first, so the count is a sliding window of `ttl`;
//   - more than `limit` hits blocks the key for `blockDuration`, during which
//     hits are not counted; the first hit after the block starts afresh;
//   - a separate key tracks the fixed window behind the Reset header.
// Time comes from the Redis server, so instances with skewed clocks agree.
// Keys share a hash tag ({...}): the script works on Redis Cluster too.
export const SLIDING_WINDOW_SCRIPT = `
local hits, blockKey, windowKey = KEYS[1], KEYS[2], KEYS[3]
local ttl, limit, blockDuration, member = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local blockedUntil = tonumber(redis.call('GET', blockKey) or '0')
if blockedUntil > 0 and blockedUntil <= now then
  redis.call('DEL', hits, blockKey)
  blockedUntil = 0
end
local blocked = blockedUntil > now

redis.call('ZREMRANGEBYSCORE', hits, '-inf', now)
local windowLeft = redis.call('PTTL', windowKey)
if windowLeft <= 0 then
  redis.call('SET', windowKey, '1', 'PX', ttl)
  windowLeft = ttl
end
if not blocked then
  redis.call('ZADD', hits, now + ttl, member)
  redis.call('PEXPIRE', hits, ttl)
end
local total = redis.call('ZCARD', hits)
if not blocked and total > limit then
  blockedUntil = now + blockDuration
  blocked = true
  redis.call('SET', blockKey, tostring(blockedUntil), 'PX', blockDuration + ttl)
end
local blockLeft = 0
if blocked then blockLeft = blockedUntil - now end
return { total, windowLeft, blocked and 1 or 0, blockLeft }
`;

// While Redis is unavailable the limiter does not fail open: each instance
// falls back to its own in-memory counters (per-instance limits) and goes back
// to Redis as soon as it answers. Both switches are logged once and counted
// (app.degraded.operations).
export class RedisRateLimitStore implements RateLimitStore, OnApplicationShutdown {
  private readonly logger = new Logger(RedisRateLimitStore.name);
  private readonly fallback = new InMemoryRateLimitStore();
  private degraded = false;

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = this.redis.key('ratelimit', `{${throttlerName}:${key}}`);
    try {
      const reply = await this.redis.run((redis) =>
        redis.eval(SLIDING_WINDOW_SCRIPT, {
          keys: [`${base}:hits`, `${base}:block`, `${base}:window`],
          arguments: [String(ttl), String(limit), String(blockDuration), randomUUID()],
        }),
      );
      this.recover();
      return toRecord(reply);
    } catch (error) {
      if (!(error instanceof RedisUnavailableError)) throw error;
      this.degrade(error);
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  onApplicationShutdown(): void {
    this.fallback.onApplicationShutdown();
  }

  private degrade(error: RedisUnavailableError): void {
    recordDegradation('rate_limit', 'redis');
    if (this.degraded) return;
    this.degraded = true;
    this.logger.warn(
      `Rate limiting falls back to per-instance counters: ${error.message}. Limits apply per instance until Redis answers again.`,
    );
  }

  private recover(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.logger.log('Rate limiting uses the shared Redis counters again');
  }
}

/** The script's reply: [hits, window ms left, blocked (1/0), block ms left]. */
export function toRecord(reply: unknown): ThrottlerStorageRecord {
  if (!Array.isArray(reply) || reply.length !== 4 || !reply.every((n) => typeof n === 'number')) {
    throw new Error(`Unexpected rate limit script reply: ${JSON.stringify(reply)}`);
  }
  const [totalHits, windowLeftMs, blocked, blockLeftMs] = reply;
  return {
    totalHits: totalHits ?? 0,
    timeToExpire: Math.ceil((windowLeftMs ?? 0) / 1000),
    isBlocked: blocked === 1,
    timeToBlockExpire: Math.ceil((blockLeftMs ?? 0) / 1000),
  };
}

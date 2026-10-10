import { createClient } from '@redis/client';
import type { RedisClientFactory } from './redis.types.js';

const CONNECT_TIMEOUT_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 5_000;

/**
 * Exponential backoff with jitter (100 ms, 200 ms, ... capped at 5 s), forever:
 * Redis coming back after a long outage must be picked up without a restart.
 * Jitter keeps every instance from reconnecting in the same millisecond.
 */
export function reconnectDelay(retries: number, random: () => number = Math.random): number {
  const base = Math.min(100 * 2 ** Math.min(retries, 10), MAX_RECONNECT_DELAY_MS);
  return base + Math.floor(random() * 100);
}

// The real client (node-redis). Commands fail at once while disconnected
// (disableOfflineQueue) instead of piling up in memory, and each one waits at
// most REDIS_COMMAND_TIMEOUT_MS: a slow Redis must not slow down every
// request. A PING every 10 s keeps idle connections alive through proxies and
// NAT and surfaces a dead peer.
export const createRedisClient: RedisClientFactory = ({ url, commandTimeoutMs }) =>
  createClient({
    url,
    disableOfflineQueue: true,
    pingInterval: 10_000,
    commandOptions: { timeout: commandTimeoutMs },
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) => reconnectDelay(retries),
    },
  });

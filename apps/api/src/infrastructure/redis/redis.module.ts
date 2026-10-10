import { Global, Module } from '@nestjs/common';
import { env } from '../../env/env.js';
import { createRedisClient } from './redis.client.js';
import { REDIS_CLIENT_FACTORY, REDIS_OPTIONS } from './redis.constants.js';
import { RedisService } from './redis.service.js';
import type { RedisOptions } from './redis.types.js';

// Always imported: without REDIS_URL, RedisService is "disabled" and nothing
// connects anywhere. Global so the adapters can inject it.
@Global()
@Module({
  providers: [
    {
      provide: REDIS_OPTIONS,
      useValue: {
        url: env.REDIS_URL,
        keyPrefix: env.REDIS_KEY_PREFIX,
        required: env.REDIS_REQUIRED,
        commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
        production: env.NODE_ENV === 'production',
      } satisfies RedisOptions,
    },
    { provide: REDIS_CLIENT_FACTORY, useValue: createRedisClient },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}

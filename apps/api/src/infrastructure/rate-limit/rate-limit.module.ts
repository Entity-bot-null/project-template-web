import { Module } from '@nestjs/common';
import { env } from '../../env/env.js';
import { RedisService } from '../redis/redis.service.js';
import {
  InMemoryRateLimitStore,
  RATE_LIMIT_STORE,
  type RateLimitStore,
  RedisRateLimitStore,
} from './rate-limit.store.js';

// Chooses the rate limit store from RATE_LIMIT_STORE (validated at boot:
// "redis" needs REDIS_URL). AppModule hands it to the ThrottlerModule.
@Module({
  providers: [
    {
      provide: RATE_LIMIT_STORE,
      inject: [RedisService],
      useFactory: (redis: RedisService): RateLimitStore =>
        env.RATE_LIMIT_STORE === 'redis'
          ? new RedisRateLimitStore(redis)
          : new InMemoryRateLimitStore(),
    },
  ],
  exports: [RATE_LIMIT_STORE],
})
export class RateLimitModule {}

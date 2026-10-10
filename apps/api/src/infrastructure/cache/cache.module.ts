import { Global, Module } from '@nestjs/common';
import { env } from '../../env/env.js';
import { RedisService } from '../redis/redis.service.js';
import { CacheService } from './cache.service.js';
import { CACHE_STORE, type CacheStore, MemoryCacheStore, RedisCacheStore } from './cache.store.js';

// CACHE_STORE picks the store (validated at boot: "redis" needs REDIS_URL).
// Global: any service can inject CacheService.
@Global()
@Module({
  providers: [
    {
      provide: CACHE_STORE,
      inject: [RedisService],
      useFactory: (redis: RedisService): CacheStore =>
        env.CACHE_STORE === 'redis' ? new RedisCacheStore(redis) : new MemoryCacheStore(),
    },
    CacheService,
  ],
  exports: [CacheService],
})
export class CacheModule {}

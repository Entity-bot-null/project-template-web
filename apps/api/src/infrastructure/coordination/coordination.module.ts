import { Global, Module } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';
import { IdempotencyService, LockService } from './coordination.service.js';
import { LEASE_STORE, type LeaseStore, MemoryLeaseStore, RedisLeaseStore } from './lease.store.js';

// Redis when it is configured (shared by every instance), else in-process.
@Global()
@Module({
  providers: [
    {
      provide: LEASE_STORE,
      inject: [RedisService],
      useFactory: (redis: RedisService): LeaseStore =>
        redis.enabled ? new RedisLeaseStore(redis) : new MemoryLeaseStore(),
    },
    LockService,
    IdempotencyService,
  ],
  exports: [LockService, IdempotencyService],
})
export class CoordinationModule {}

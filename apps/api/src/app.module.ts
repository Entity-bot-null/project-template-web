import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccountModule } from './account/account.module.js';
import { AuthModule } from './auth/auth.module.js';
import { FetchMetadataGuard } from './common/guards/fetch-metadata.guard.js';
import { RateLimitGuard, rateLimitOptions } from './common/guards/rate-limit.guard.js';
import { env } from './env/env.js';
import { HealthModule } from './health/health.module.js';
import { CacheModule } from './infrastructure/cache/cache.module.js';
import { CoordinationModule } from './infrastructure/coordination/coordination.module.js';
import { MailModule } from './infrastructure/mail/mail.module.js';
import { RateLimitModule } from './infrastructure/rate-limit/rate-limit.module.js';
import {
  RATE_LIMIT_STORE,
  type RateLimitStore,
} from './infrastructure/rate-limit/rate-limit.store.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { InvitationsModule } from './invitations/invitations.module.js';
import { GracefulShutdown, ShutdownStateModule } from './lifecycle/shutdown.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { TelemetryModule } from './telemetry/telemetry.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ShutdownStateModule,
    // Optional infrastructure: without REDIS_URL every adapter below uses its
    // in-process implementation (docs/architecture.md#optional-infrastructure).
    RedisModule,
    CacheModule,
    CoordinationModule,
    // The global limit and the routes' own (common/guards/rate-limit.guard.ts),
    // counted in the store RATE_LIMIT_STORE names: memory for one instance,
    // Redis when several share the limits (docs/security.md#rate-limiting).
    ThrottlerModule.forRootAsync({
      imports: [RateLimitModule],
      inject: [RATE_LIMIT_STORE],
      useFactory: (storage: RateLimitStore) =>
        rateLimitOptions(storage, {
          limit: env.RATE_LIMIT_MAX,
          windowSec: env.RATE_LIMIT_WINDOW_SEC,
        }),
    }),
    PrismaModule,
    // Email (docs/architecture.md#email); off without MAIL_SMTP_URL. After
    // PrismaModule on purpose: global modules are destroyed in the reverse
    // order of these imports, so the mail worker stops (finishing the message
    // it is sending) before the database pool closes.
    MailModule,
    AuthModule,
    AccountModule,
    InvitationsModule,
    UsersModule,
    HealthModule,
    TelemetryModule,
  ],
  providers: [
    // In the root module so its destroy hook runs first: requests in flight
    // finish before the database and Redis connections close.
    GracefulShutdown,
    // Global guards run in this order, before any controller guard. Requests
    // another site made a browser send are refused first, so they cannot use up
    // a victim's rate limit; the limiter then counts everything else,
    // unauthenticated and forbidden requests included.
    { provide: APP_GUARD, useClass: FetchMetadataGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}

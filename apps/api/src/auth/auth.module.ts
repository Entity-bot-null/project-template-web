import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { env } from '../env/env.js';
import { ACCESS_TOKEN_ALGORITHM, ACCESS_TOKEN_TTL_SEC } from './auth.constants.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [
    JwtModule.register({
      secret: env.JWT_ACCESS_SECRET,
      // Pinned so a verifier can never be talked into another algorithm.
      signOptions: { expiresIn: ACCESS_TOKEN_TTL_SEC, algorithm: ACCESS_TOKEN_ALGORITHM },
      verifyOptions: { algorithms: [ACCESS_TOKEN_ALGORITHM] },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, SessionsService],
  // @Auth() instantiates JwtAuthGuard in the importing module, so what must
  // be exported is the JwtModule (the one JwtService with the pinned options).
  exports: [JwtModule, SessionsService],
})
export class AuthModule {}

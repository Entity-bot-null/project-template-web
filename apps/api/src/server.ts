import type { LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { env } from './env/env.js';
import { buildOpenApiDocument } from './openapi/openapi.js';

// The HTTP server, started by main.ts once observability is up.
export async function startServer(logger: LoggerService): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
  configureApp(app);

  // Interactive docs outside production only (http://localhost:3000/api/docs).
  // The committed openapi/openapi.json is the contract; this is the same
  // document, served live from the running code.
  if (env.NODE_ENV !== 'production') {
    SwaggerModule.setup('api/docs', app, buildOpenApiDocument(app));
  }

  // Without HOST (production default) Node listens on every interface, IPv4 and
  // IPv6; outside production HOST defaults to loopback (src/env/env.schema.ts).
  await (env.HOST === undefined ? app.listen(env.PORT) : app.listen(env.PORT, env.HOST));
}

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../app.module.js';
import { configureApp } from '../app.setup.js';
import { buildOpenApiDocument, OPENAPI_JSON_PATH } from './openapi.js';

// `pnpm contract` (repository root) runs this, then regenerates the web
// client types from the result. Writes openapi/openapi.json, or the path
// given as first argument. The app is created but never initialized, so no
// database connection is opened: only the environment must be valid.
const target = process.argv[2] === undefined ? OPENAPI_JSON_PATH : resolve(process.argv[2]);
const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
configureApp(app);
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`);
console.log(`OpenAPI document written to ${target}`);
process.exit(0);

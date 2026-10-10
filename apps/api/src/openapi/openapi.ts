import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { errorResponse } from '../common/openapi/api.decorators.js';
import { ERROR_RESPONSE_SCHEMA_NAME, errorResponseSchema } from '../common/openapi/zod-schema.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

// The committed contract, openapi/openapi.json at the repository root.
// Resolved from this module (src/ and dist/ sit at the same depth), so the
// export and the drift spec read the same file whatever the working directory.
export const OPENAPI_JSON_PATH = fileURLToPath(
  new URL('../../../../openapi/openapi.json', import.meta.url),
);

// Path parameters named `id` or `<name>Id` are UUIDs (ParseUUIDPipe).
const UUID_PARAM = /^(id|[a-z][A-Za-z]*Id)$/;
// Routes exempt from rate limiting (@SkipThrottle) never answer 429.
const UNTHROTTLED_PREFIXES = ['/api/health/'];

// Builds the document from the running Nest app: routes and parameters from
// the controllers, bodies and payloads from the Zod schemas through @ZodBody,
// @ZodQuery and @ApiData. The export script, the drift spec and the dev
// Swagger UI all call this, so they always agree.
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('API')
    .setVersion(version)
    .setDescription(
      'REST API under /api. Every response body is { data, message }; errors carry data: null. Authenticated routes take the access token from POST /api/auth/sign-in as a bearer token; the refresh token is an httpOnly cookie.',
    )
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas[ERROR_RESPONSE_SCHEMA_NAME] = errorResponseSchema;
  annotateOperations(document);
  return document;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

// Facts no single controller owns: UUID path parameters and the global rate
// limiter.
function annotateOperations(document: OpenAPIObject): void {
  const { status, description, schema } = errorResponse(429);
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      for (const param of operation.parameters ?? []) {
        if ('in' in param && param.in === 'path' && UUID_PARAM.test(param.name)) {
          if (param.schema && 'type' in param.schema) param.schema.format = 'uuid';
        }
      }
      if (!UNTHROTTLED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
        operation.responses[String(status)] = {
          description,
          content: { 'application/json': { schema } },
        };
      }
    }
  }
}

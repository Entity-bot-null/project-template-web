import { applyDecorators, UsePipes } from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { z } from 'zod';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { ERROR_RESPONSE_SCHEMA_NAME, envelope, zodToOpenApi } from './zod-schema.js';

// Validates the JSON body with the Zod schema AND documents it in OpenAPI
// from the same object, so validation and contract cannot drift apart. Keep
// `@Body()` bare on the parameter.
export function ZodBody(
  schema: z.ZodType,
  { required = true }: { required?: boolean } = {},
): MethodDecorator {
  return applyDecorators(
    // An optional body may be missing altogether (no Content-Type).
    UsePipes(new ZodValidationPipe(required ? schema : schema.optional(), 'body')),
    ApiBody({ schema: zodToOpenApi(schema, 'input'), required }),
  );
}

// Same for query strings: validates `@Query()` and documents one parameter
// per property. The schema must be a z.object(...), and numeric fields need
// z.coerce (a query string only ever carries strings).
export function ZodQuery(schema: z.ZodObject): MethodDecorator {
  const json = zodToOpenApi(schema, 'input');
  const required = new Set(json.required ?? []);
  const queries = Object.entries(json.properties ?? {}).map(([name, property]) =>
    ApiQuery({ name, required: required.has(name), schema: property }),
  );
  return applyDecorators(UsePipes(new ZodValidationPipe(schema, 'query')), ...queries);
}

export interface ApiDataOptions {
  status?: number;
  description?: string;
  isArray?: boolean;
}

// Documents the successful response: `schema` describes `data`, the helper
// adds the { data, message } envelope.
export function ApiData(
  schema: z.ZodType,
  { status = 200, description, isArray = false }: ApiDataOptions = {},
): MethodDecorator {
  const data = zodToOpenApi(schema, 'output');
  return ApiResponse({
    status,
    description: description ?? (status === 201 ? 'Created' : 'OK'),
    schema: envelope(isArray ? { type: 'array', items: data } : data),
  });
}

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Validation failed',
  401: 'Not authenticated',
  403: 'Not allowed',
  404: 'Not found',
  409: 'Conflict',
  429: 'Rate limit exceeded',
  503: 'Service unavailable',
};

// Lists the error statuses a route can answer with; all share the error
// envelope. 429 is added to every rate-limited route by the document builder.
export function ApiErrors(...statuses: number[]): MethodDecorator {
  return applyDecorators(...statuses.map((status) => ApiResponse(errorResponse(status))));
}

export function errorResponse(status: number) {
  const description = ERROR_DESCRIPTIONS[status];
  if (description === undefined) {
    throw new Error(`No description for error status ${status}`);
  }
  return {
    status,
    description,
    schema: { $ref: `#/components/schemas/${ERROR_RESPONSE_SCHEMA_NAME}` },
  };
}

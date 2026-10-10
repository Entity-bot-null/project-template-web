import type { SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';

// Bridges the Zod schemas (the single source of truth for request and
// response shapes) to the OpenAPI document. Zod emits JSON Schema natively;
// the OpenAPI 3.0 target keeps `nullable` and avoids 2020-12-only keywords so
// every generator reads it the same way. `input` documents what a client may
// send (defaults optional), `output` what it receives (defaults applied).
export function zodToOpenApi(schema: z.ZodType, io: 'input' | 'output' = 'input'): SchemaObject {
  const { $schema: _, ...json } = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io,
    unrepresentable: 'any',
  });
  return stripFormatPatterns(json) as SchemaObject;
}

// Zod backs `format: email|uuid|date-time|date` with a long regex `pattern`,
// and bounds integers with the JS safe range. The format alone is the
// contract (what readers and generators use) and the range says nothing
// about the API, so both are dropped. A custom regex on its own is kept: it
// is part of the contract.
const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const ZOD_FORMAT_PATTERNS = new Map<string, string>([
  [z.regexes.email.source, 'email'],
  [z.regexes.uuid().source, 'uuid'],
  [z.regexes.datetime({}).source, 'date-time'],
  [z.regexes.date.source, 'date'],
]);

function stripFormatPatterns(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripFormatPatterns);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'pattern' && typeof value === 'string') {
      const format = ZOD_FORMAT_PATTERNS.get(value);
      if (format !== undefined) {
        out.format ??= format;
        continue;
      }
      if ('format' in node) continue;
    }
    if (key === 'maximum' && value === SAFE_INTEGER) continue;
    if (key === 'minimum' && value === -SAFE_INTEGER) continue;
    out[key] = stripFormatPatterns(value);
  }
  return out;
}

/** Every successful response is wrapped by TransformInterceptor. */
export function envelope(data: SchemaObject): SchemaObject {
  return {
    type: 'object',
    required: ['data', 'message'],
    properties: { data, message: { type: 'string' } },
  };
}

export const ERROR_RESPONSE_SCHEMA_NAME = 'ErrorResponse';

/** Errors are normalized by AllExceptionsFilter: data is always null. */
export const errorResponseSchema: SchemaObject = {
  type: 'object',
  required: ['data', 'message'],
  properties: {
    // OpenAPI 3.0 has no null type: a nullable enum of null is the idiom
    // generators read as exactly `null`.
    data: { nullable: true, enum: [null] },
    message: { type: 'string' },
  },
};

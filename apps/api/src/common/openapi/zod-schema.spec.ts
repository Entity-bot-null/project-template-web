import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { envelope, zodToOpenApi } from './zod-schema.js';

describe('zodToOpenApi', () => {
  it('documents formats without the regex Zod uses to check them', () => {
    const json = zodToOpenApi(z.object({ id: z.uuid(), email: z.email(), at: z.iso.datetime() }));
    expect(json.properties).toEqual({
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      at: { type: 'string', format: 'date-time' },
    });
  });

  it('keeps a custom pattern, which is part of the contract', () => {
    const json = zodToOpenApi(z.object({ slug: z.string().regex(/^[a-z-]+$/) }));
    expect(json.properties?.slug).toMatchObject({ pattern: '^[a-z-]+$' });
  });

  it('drops the safe-integer bounds Zod adds to every integer', () => {
    const json = zodToOpenApi(z.object({ n: z.number().int(), m: z.number().int().max(10) }));
    expect(json.properties?.n).toEqual({ type: 'integer' });
    expect(json.properties?.m).toEqual({ type: 'integer', maximum: 10 });
  });

  it('marks defaulted input fields optional and output fields required', () => {
    const schema = z.object({ limit: z.number().default(20) });
    expect(zodToOpenApi(schema, 'input').required).toBeUndefined();
    expect(zodToOpenApi(schema, 'output').required).toEqual(['limit']);
  });
});

describe('envelope', () => {
  it('wraps a payload schema in { data, message }', () => {
    expect(envelope({ type: 'string' })).toEqual({
      type: 'object',
      required: ['data', 'message'],
      properties: { data: { type: 'string' }, message: { type: 'string' } },
    });
  });
});

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const Schema = z.object({ title: z.string().min(1), count: z.coerce.number().default(1) });
const meta = (type: 'body' | 'query') => ({ type, metatype: undefined, data: undefined });

describe('ZodValidationPipe', () => {
  it('returns the parsed body: defaults applied, unknown keys stripped', () => {
    const pipe = new ZodValidationPipe(Schema);
    expect(pipe.transform({ title: 'ok', extra: true }, meta('body'))).toEqual({
      title: 'ok',
      count: 1,
    });
  });

  it('rejects an invalid body with every problem and its path', () => {
    const pipe = new ZodValidationPipe(Schema);
    expect(() => pipe.transform({ title: '' }, meta('body'))).toThrow(BadRequestException);
    expect(() => pipe.transform({ title: '' }, meta('body'))).toThrow(/^title: /);
  });

  it('validates only its own argument type', () => {
    const body = new ZodValidationPipe(Schema, 'body');
    const query = new ZodValidationPipe(Schema, 'query');
    expect(body.transform({}, meta('query'))).toEqual({});
    expect(query.transform({}, meta('body'))).toEqual({});
    expect(query.transform({ title: 'x', count: '3' }, meta('query'))).toEqual({
      title: 'x',
      count: 3,
    });
  });
});

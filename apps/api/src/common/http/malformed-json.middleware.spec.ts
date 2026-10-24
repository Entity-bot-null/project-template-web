import { BadRequestException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { MALFORMED_JSON_MESSAGE, malformedJson } from './malformed-json.middleware.js';

const run = (error: unknown) => {
  const next = vi.fn();
  malformedJson(error, {} as Request, {} as Response, next);
  return next.mock.calls[0]?.[0] as unknown;
};

describe('malformedJson', () => {
  it("answers a parse failure with one plain message, never the parser's text", () => {
    const parse = Object.assign(new SyntaxError(`Unexpected token 'h', "{"password": hunter2}"`), {
      status: 400,
      expose: true,
      type: 'entity.parse.failed',
    });
    const passed = run(parse);
    expect(passed).toBeInstanceOf(BadRequestException);
    expect((passed as BadRequestException).message).toBe(MALFORMED_JSON_MESSAGE);
  });

  it('passes every other error on as it is', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
      type: 'entity.too.large',
    });
    expect(run(tooLarge)).toBe(tooLarge);
    expect(run('not an error')).toBe('not an error');
  });
});

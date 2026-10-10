import type { ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MESSAGE, TransformInterceptor } from './transform.interceptor.js';

const run = (body: unknown) =>
  lastValueFrom(
    new TransformInterceptor().intercept({} as ExecutionContext, { handle: () => of(body) }),
  );

describe('TransformInterceptor', () => {
  it('wraps a plain value in the envelope', async () => {
    await expect(run({ id: 1 })).resolves.toEqual({ data: { id: 1 }, message: DEFAULT_MESSAGE });
    await expect(run([1, 2])).resolves.toEqual({ data: [1, 2], message: DEFAULT_MESSAGE });
  });

  it('turns an empty result into data: null', async () => {
    await expect(run(undefined)).resolves.toEqual({ data: null, message: DEFAULT_MESSAGE });
  });

  it('passes an envelope through, so a controller can choose the message', async () => {
    await expect(run({ data: { id: 1 }, message: 'Created' })).resolves.toEqual({
      data: { id: 1 },
      message: 'Created',
    });
  });
});

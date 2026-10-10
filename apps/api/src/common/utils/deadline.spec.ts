import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeadlineExceededError, withDeadline } from './deadline.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('withDeadline', () => {
  it('passes the result or the failure through when it comes in time', async () => {
    await expect(withDeadline(Promise.resolve('answer'), 100)).resolves.toBe('answer');
    const failure = new Error('refused');
    await expect(withDeadline(Promise.reject(failure), 100)).rejects.toBe(failure);
  });

  it('gives up at the deadline on an operation that never settles', async () => {
    vi.useFakeTimers();
    const outcome = withDeadline(new Promise(() => undefined), 2_500);
    const assertion = expect(outcome).rejects.toEqual(new DeadlineExceededError(2_500));
    await vi.advanceTimersByTimeAsync(2_500);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops the late failure of an abandoned operation instead of leaving it unhandled', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let fail!: (error: Error) => void;
      const late = new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
      await expect(withDeadline(late, 10)).rejects.toBeInstanceOf(DeadlineExceededError);
      fail(new Error('too late'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { MAIL_RETRY_BASE_MS, MAIL_RETRY_MAX_MS } from './mail.constants.js';
import { retryDelayMs } from './retry-delay.js';

const low = () => 0;
const high = () => 1;

describe('retryDelayMs', () => {
  it('doubles from 30 seconds after each failed attempt', () => {
    expect([1, 2, 3, 4].map((attempts) => retryDelayMs(attempts, high))).toEqual([
      MAIL_RETRY_BASE_MS,
      MAIL_RETRY_BASE_MS * 2,
      MAIL_RETRY_BASE_MS * 4,
      MAIL_RETRY_BASE_MS * 8,
    ]);
  });

  it('never waits more than an hour, however many attempts failed', () => {
    expect(retryDelayMs(30, high)).toBe(MAIL_RETRY_MAX_MS);
    expect(retryDelayMs(10_000, high)).toBe(MAIL_RETRY_MAX_MS);
  });

  it('spreads retries between half the delay and the whole of it (equal jitter)', () => {
    expect(retryDelayMs(3, low)).toBe((MAIL_RETRY_BASE_MS * 4) / 2);
    expect(retryDelayMs(3, () => 0.5)).toBe(MAIL_RETRY_BASE_MS * 3);
    for (let i = 0; i < 100; i++) {
      const delay = retryDelayMs(5);
      expect(delay).toBeGreaterThanOrEqual(MAIL_RETRY_BASE_MS * 8);
      expect(delay).toBeLessThanOrEqual(MAIL_RETRY_BASE_MS * 16);
    }
  });

  it('treats a nonsensical attempt count as the first retry', () => {
    expect(retryDelayMs(0, high)).toBe(MAIL_RETRY_BASE_MS);
    expect(retryDelayMs(-3, high)).toBe(MAIL_RETRY_BASE_MS);
  });
});

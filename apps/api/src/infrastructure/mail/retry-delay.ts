import { MAIL_RETRY_BASE_MS, MAIL_RETRY_MAX_MS } from './mail.constants.js';

/**
 * How long to wait after the `attempts`-th failed attempt (1-based):
 * exponential (30 s, 1 min, 2 min... at most an hour) with equal jitter, half
 * the delay plus a random share of the other half, so messages that failed
 * together (an SMTP outage) do not all come back at the same moment.
 */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.floor(attempts) - 1);
  const delay = Math.min(MAIL_RETRY_MAX_MS, MAIL_RETRY_BASE_MS * 2 ** exponent);
  return Math.round(delay / 2 + random() * (delay / 2));
}

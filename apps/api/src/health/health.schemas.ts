import { z } from 'zod';

export const LivenessSchema = z.object({
  status: z.literal('ok'),
  /** Seconds since the process started. */
  uptime: z.number().int(),
});

export const ReadinessSchema = z.object({
  /** "degraded": serving, but an optional dependency is down (features fall back). */
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    database: z.literal('ok'),
    /** "disabled": Redis is not configured (REDIS_URL unset). */
    redis: z.enum(['ok', 'unavailable', 'disabled']),
    /**
     * "disabled": email is not configured (MAIL_SMTP_URL unset). "degraded":
     * the latest deliveries failed for a reason of the server's or ours, or
     * messages have waited longer than 15 minutes. Never fails the probe.
     */
    mail: z.enum(['ok', 'degraded', 'disabled']),
  }),
});

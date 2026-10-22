/** MailOptions, from the environment by default (tests override the provider). */
export const MAIL_OPTIONS = Symbol('MAIL_OPTIONS');
/** Creates the SMTP transport; specs replace it to inject failures. */
export const MAIL_TRANSPORT_FACTORY = Symbol('MAIL_TRANSPORT_FACTORY');
/** The templates by kind (templates/registry.ts); specs replace them. */
export const MAIL_TEMPLATES = Symbol('MAIL_TEMPLATES');

// The worker (mail-worker.service.ts) looks for due messages this often, and
// at once when a message is queued in this process.
export const MAIL_POLL_INTERVAL_MS = 5_000;

// SMTP timeouts: connecting, the server's greeting, and silence on the socket.
export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
export const SMTP_SOCKET_TIMEOUT_MS = 30_000;

// A claim's lease: short enough that a crashed worker's message is taken over
// within minutes. The SMTP timeouts above apply to each step, not to the whole
// exchange (a slow relay that answers every step just in time can take longer
// than the lease), so a live worker renews its lease while it sends, and never
// loses a message it is still sending. Messages are claimed one at a time, so
// no message waits in a claimed batch.
export const MAIL_LEASE_MS = 120_000;
export const MAIL_LEASE_RENEW_MS = MAIL_LEASE_MS / 3;
// The longest a worker keeps renewing for one exchange: then the lease runs
// out and another worker may take the message over.
export const MAIL_EXCHANGE_MAX_MS = 10 * 60_000;

// Appended to the reason of a message dropped while a worker held it under a
// live lease (MailOutboxService.expireQueued): that worker counts it
// (MailStore.fateOf); the caller counts the others.
export const DROPPED_WHILE_HELD = ':held';

// Retries: exponential from 30 seconds, at most an hour apart, with jitter.
export const MAIL_RETRY_BASE_MS = 30_000;
export const MAIL_RETRY_MAX_MS = 3_600_000;

// At most one message a minute to an address, from the kinds anyone can
// request (the daily limit is MAIL_DAILY_LIMIT_PER_ADDRESS).
export const MAIL_PER_ADDRESS_PER_MINUTE = 1;

// Retention: finished rows (sent, expired, failed) are deleted after 30 days;
// a failed message's address is cleared after 7, when retrying it no longer
// makes sense. The sweep runs every hour.
export const MAIL_RETENTION_DAYS = 30;
export const MAIL_FAILED_ADDRESS_RETENTION_DAYS = 7;
export const MAIL_SWEEP_INTERVAL_MS = 3_600_000;

// Queue statistics (the gauges and the health) are read this often.
export const MAIL_STATS_INTERVAL_MS = 30_000;

// Health: degraded while the latest delivery attempt failed for a reason that
// is not the message's own (connection, timeout, credentials), for at most
// this long after it; or while the oldest waiting message is older than this.
export const MAIL_FAILURE_DEGRADED_MS = 15 * 60_000;
export const MAIL_BACKLOG_DEGRADED_SEC = 15 * 60;

// How long a stopping API waits for the message it is sending.
export const MAIL_SHUTDOWN_GRACE_MS = 10_000;

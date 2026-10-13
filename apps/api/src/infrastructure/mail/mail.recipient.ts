import { createHmac, hkdfSync } from 'node:crypto';
import { normalizeEmail } from '../../auth/auth.constants.js';

// The outbox keeps an address only while a message may still need it, and a
// keyed hash of it for good: per-address limits and "what did we send to this
// address?" without a column of addresses. Keyed (HMAC), because an address
// is guessable: a plain hash could be reversed by hashing candidate addresses.
// The key is derived from JWT_ACCESS_SECRET, so no new secret is needed; when
// that secret rotates, hashes made before no longer match (the limits start
// over, and old rows are found by id instead of by address).

/** The HMAC key for recipient hashes, derived from the API's signing secret (HKDF-SHA256). */
export function deriveRecipientKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'mail-recipient-hash', 'mail recipient v1', 32));
}

/**
 * The mailbox an address delivers to, for the per-address limits: normalized
 * (case, spaces), without a +tag (ada+1@ and ada+2@ reach ada@'s mailbox, and
 * would otherwise each get their own share of messages).
 */
export function mailboxOf(address: string): string {
  const normalized = normalizeEmail(address);
  const at = normalized.lastIndexOf('@');
  const plus = normalized.indexOf('+');
  return plus > 0 && plus < at ? `${normalized.slice(0, plus)}${normalized.slice(at)}` : normalized;
}

/** One mailbox (whatever the case, spaces or +tag of its address) always gives the same hash. */
export function recipientHash(key: Buffer, address: string): string {
  return createHmac('sha256', key).update(mailboxOf(address)).digest('hex');
}

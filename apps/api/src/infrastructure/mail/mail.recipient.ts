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

/** The same address (whatever its case or surrounding spaces) always gives the same hash. */
export function recipientHash(key: Buffer, address: string): string {
  return createHmac('sha256', key).update(normalizeEmail(address)).digest('hex');
}

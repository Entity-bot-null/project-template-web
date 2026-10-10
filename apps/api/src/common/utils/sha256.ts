import { createHash } from 'node:crypto';

/**
 * Hex SHA-256. Fine for high-entropy values (random tokens) to keep the raw
 * value out of the database and logs; never for passwords (see password.ts).
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

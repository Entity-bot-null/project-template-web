import { describe, expect, it } from 'vitest';
import { deriveRecipientKey, recipientHash } from './mail.recipient.js';

const key = deriveRecipientKey('a'.repeat(64));

describe('recipient hashes', () => {
  it('is the same for an address whatever its case or surrounding spaces (limits cannot be dodged)', () => {
    const hash = recipientHash(key, 'Someone@Example.test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(recipientHash(key, '  someone@example.test ')).toBe(hash);
    expect(recipientHash(key, 'SOMEONE@EXAMPLE.TEST')).toBe(hash);
    expect(recipientHash(key, 'someone.else@example.test')).not.toBe(hash);
  });

  it('is keyed: another secret gives another hash, so a list of addresses cannot reverse it', () => {
    const otherKey = deriveRecipientKey('b'.repeat(64));
    expect(recipientHash(otherKey, 'someone@example.test')).not.toBe(
      recipientHash(key, 'someone@example.test'),
    );
    expect(deriveRecipientKey('a'.repeat(64))).toEqual(key);
    expect(key).toHaveLength(32);
  });
});

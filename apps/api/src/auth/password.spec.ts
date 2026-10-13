import argon2 from 'argon2';
import { describe, expect, it, vi } from 'vitest';
import { checkPassword, dummyPasswordHash, hashPassword, verifyPassword } from './password.js';

// "Café" with é as one code point (NFC, what NFKC gives) and as e + a combining
// accent (what some keyboards and systems type).
const COMPOSED = 'Caf\u00e9 au lait every morning';
const DECOMPOSED = 'Cafe\u0301 au lait every morning';

describe('password hashing', () => {
  it('hashes with argon2id at the OWASP minimum parameters', async () => {
    const [, algorithm, version, params] = (await hashPassword('correct horse')).split('$');
    expect(algorithm).toBe('argon2id');
    expect(version).toBe('v=19');
    expect(params?.split(',').sort()).toEqual(['m=19456', 'p=1', 't=2']);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('verifies the right password only', async () => {
    const hash = await hashPassword('correct horse');
    await expect(verifyPassword(hash, 'correct horse')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong horse')).resolves.toBe(false);
  });

  it('answers false for a malformed hash instead of throwing', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('builds the timing dummy once', async () => {
    const first = await dummyPasswordHash();
    expect(await dummyPasswordHash()).toBe(first);
    await expect(verifyPassword(first, 'anything')).resolves.toBe(false);
  });

  it('hashes the NFKC form: the same password typed composed or decomposed matches', async () => {
    const hash = await hashPassword(DECOMPOSED);
    await expect(checkPassword(hash, COMPOSED)).resolves.toBe(true);
    await expect(checkPassword(hash, DECOMPOSED)).resolves.toBe(true);
    await expect(checkPassword(hash, 'Cafe au lait every morning')).resolves.toBe(false);
  });

  it('still verifies a hash made before normalization, from the password as typed', async () => {
    // A hash of the decomposed form itself, as an older version stored it.
    const legacy = await argon2.hash(DECOMPOSED, { type: argon2.argon2id });
    await expect(checkPassword(legacy, DECOMPOSED)).resolves.toBe(true);
    await expect(checkPassword(legacy, 'wrong')).resolves.toBe(false);
  });

  it('runs as many hashes for an unknown account as for a known one: the input decides, not the account', async () => {
    const verify = vi.spyOn(argon2, 'verify');
    const known = await hashPassword('the account password');
    const dummy = await dummyPasswordHash();
    for (const input of ['wrong password', DECOMPOSED]) {
      verify.mockClear();
      await checkPassword(known, input);
      const forKnown = verify.mock.calls.length;
      verify.mockClear();
      await checkPassword(dummy, input);
      expect(verify.mock.calls.length, input).toBe(forKnown);
    }
    // Two only when the typed form differs from its NFKC form.
    verify.mockClear();
    await checkPassword(known, DECOMPOSED);
    expect(verify).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it } from 'vitest';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.js';

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
});

import argon2 from 'argon2';

// argon2id at the OWASP minimum (19 MiB, 2 passes, 1 lane): about 20 ms and
// 19 MiB per hash. Raise the cost here only; every hash carries its own
// parameters, so existing ones keep verifying.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** False on a wrong password and on a malformed hash, never throws. */
export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password).catch(() => false);
}

let dummyHash: Promise<string> | undefined;

// Verified against when the email is unknown, so a missing account costs the
// same time as a wrong password and the response never tells them apart.
// Built once, on first use, with the same parameters as real hashes.
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-for-timing').catch((error: unknown) => {
    dummyHash = undefined;
    throw error;
  });
  return dummyHash;
}

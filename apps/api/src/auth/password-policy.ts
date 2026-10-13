import { PASSWORD_MAX_LENGTH } from './auth.constants.js';
import { COMMON_PASSWORD_LIST } from './common-passwords.js';

// The rules for a password someone chooses (docs/security.md#passwords),
// after NIST SP 800-63B-4 for a password that is the only factor: at least 15
// characters, at most PASSWORD_MAX_LENGTH, any character (spaces and Unicode
// included, never truncated), no composition rules (no "one digit and one
// symbol"), and a refusal of what an attacker tries first: passwords people
// use most, repetitions and sequences, the account's own email or name.
// Everything is checked here, on this server: no password is sent anywhere to
// be looked up. Sign-in applies none of this: what was accepted when it was
// set keeps working.

export const PASSWORD_MIN_LENGTH = 15;

/**
 * The form a password is hashed and compared in: Unicode NFKC, so the same
 * password typed as composed or decomposed characters (é as one code point or
 * two) is the same password.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

/**
 * Characters as NIST counts them: code points ("each Unicode code point SHALL
 * be counted as a single character"), not UTF-16 units: an emoji is one.
 */
export function passwordLength(password: string): number {
  return Array.from(password).length;
}

export interface PasswordContext {
  /** The account's email: its address must not be in the password. */
  email?: string;
  /** The account's name: none of its words (4+ characters) may be in the password. */
  name?: string;
}

let commonPasswords: ReadonlySet<string> | undefined;
const isCommon = (comparable: string): boolean =>
  (commonPasswords ??= new Set(COMMON_PASSWORD_LIST.split('\n'))).has(comparable);

/**
 * Why a new password is refused, in words for the person choosing it;
 * undefined when it is acceptable.
 */
export function passwordProblem(
  password: string,
  context: PasswordContext = {},
): string | undefined {
  const normalized = normalizePassword(password);
  const length = passwordLength(normalized);
  if (length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`;
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${String(PASSWORD_MAX_LENGTH)} characters.`;
  }
  const comparable = normalized.toLowerCase();
  if (isCommon(comparable)) return 'This password is one of the most used: choose another one.';
  if (isPredictable(comparable)) {
    return 'This password is too easy to guess: avoid repeated characters and sequences.';
  }
  if (containsAccount(comparable, context)) {
    return 'Leave your email address and your name out of your password.';
  }
  return undefined;
}

// Repetitions and sequences: "aaaaaaaaaaaaaaa", "abcabcabcabcabc",
// "abcdefghijklmnop", "543210987654321". Few distinct characters, a short
// unit repeated three times or more, or mostly consecutive characters.
function isPredictable(comparable: string): boolean {
  const characters = Array.from(comparable);
  if (new Set(characters).size < 4) return true;
  if (/^(.+?)\1{2,}$/su.test(comparable)) return true;
  let steps = 0;
  for (let i = 1; i < characters.length; i++) {
    const step = (characters[i]?.codePointAt(0) ?? 0) - (characters[i - 1]?.codePointAt(0) ?? 0);
    if (step === 1 || step === -1) steps++;
  }
  return steps >= (characters.length - 1) * 0.8;
}

function containsAccount(comparable: string, { email, name }: PasswordContext): boolean {
  const words: string[] = [];
  if (email !== undefined) {
    const address = normalizePassword(email.trim()).toLowerCase();
    words.push(address, address.slice(0, Math.max(0, address.lastIndexOf('@'))));
  }
  if (name !== undefined) {
    words.push(
      ...normalizePassword(name)
        .toLowerCase()
        .split(/[\s\p{P}]+/u),
    );
  }
  return words.some((word) => passwordLength(word) >= 4 && comparable.includes(word));
}

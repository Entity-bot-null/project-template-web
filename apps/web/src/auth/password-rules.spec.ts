import { describe, expect, it } from 'vitest';
import { newPasswordError } from './password-rules';

// The quick feedback on a new password; the API checks it again
// (apps/api/src/auth/password-policy.spec.ts), plus the most used passwords.

describe('newPasswordError', () => {
  it('accepts a long passphrase, spaces and any characters included', () => {
    expect(newPasswordError('violet harbour lantern 7')).toBeNull();
    expect(newPasswordError('mañana llueve en Cádiz ☔')).toBeNull();
  });

  it('asks for 15 characters at least and 200 at most, counted as the API counts them', () => {
    expect(newPasswordError('')).toBe('Choose a password.');
    expect(newPasswordError('fourteen chars')).toBe('Use at least 15 characters (14 now).');
    // 14 emoji are 28 UTF-16 units, still 14 characters.
    expect(newPasswordError('🦊'.repeat(14))).toBe('Use at least 15 characters (14 now).');
    expect(newPasswordError(`${'violet harbour '.repeat(13)}lantern`)).toBe(
      'Use at most 200 characters.',
    );
  });

  it.each([
    ['one character repeated', 'aaaaaaaaaaaaaaaaaaaa'],
    ['a few characters', 'abababababababababab'],
    ['a block repeated', 'abcdabcdabcdabcdabcd'],
    ['a sequence', 'abcdefghijklmnopqrst'],
    ['a sequence backwards', 'zyxwvutsrqponmlkjihg'],
  ])('refuses %s', (_case, password) => {
    expect(newPasswordError(password)).toBe(
      'Too easy to guess: avoid repeated characters and sequences.',
    );
  });

  it('refuses the email address, its local part or a word of the name in the password', () => {
    const context = { email: 'ada.lovelace@example.com', name: 'Ada Lovelace' };
    const refused = 'Leave your email address and your name out of your password.';
    expect(newPasswordError('ADA.LOVELACE@example.com rocks', context)).toBe(refused);
    expect(newPasswordError('my ada.lovelace passphrase', context)).toBe(refused);
    expect(newPasswordError('dear lovelace, write back', context)).toBe(refused);
    // Compared once normalized: full-width letters are the same letters.
    expect(newPasswordError('ｌｏｖｅｌａｃｅ forever and ever', context)).toBe(refused);
    // Words shorter than 4 characters are too common to refuse.
    expect(newPasswordError('ada walks on long beaches', context)).toBeNull();
  });
});

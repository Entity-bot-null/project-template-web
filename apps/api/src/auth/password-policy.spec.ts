import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX_LENGTH } from './auth.constants.js';
import { COMMON_PASSWORD_LIST } from './common-passwords.js';
import {
  normalizePassword,
  PASSWORD_MIN_LENGTH,
  passwordLength,
  passwordProblem,
} from './password-policy.js';

const GOOD = 'violet harbour lantern 7';

describe('passwordProblem', () => {
  it('accepts a long passphrase: no composition rules, spaces and any letters allowed', () => {
    expect(passwordProblem(GOOD)).toBeUndefined();
    expect(passwordProblem('only lowercase words here')).toBeUndefined();
    expect(passwordProblem('  leading and trailing spaces count  ')).toBeUndefined();
    expect(passwordProblem('Ñandú sobre el río Paraná')).toBeUndefined();
    expect(passwordProblem('日本語のパスワードは十五文字以上')).toBeUndefined();
  });

  it('counts characters, not UTF-16 units: an emoji is one, never truncated', () => {
    const emoji = '🔒🌊🦊🍀🎈🚲🧭🪁🌙🍉🐢🎻📚🧩🌵';
    expect(emoji.length).toBe(30);
    expect(passwordLength(emoji)).toBe(PASSWORD_MIN_LENGTH);
    expect(passwordProblem(emoji)).toBeUndefined();
    expect(passwordProblem(emoji.slice(0, -2))).toBe('Use at least 15 characters.');
  });

  it(`refuses fewer than ${String(PASSWORD_MIN_LENGTH)} and more than ${String(PASSWORD_MAX_LENGTH)} characters`, () => {
    expect(passwordProblem('fourteen chars')).toBe('Use at least 15 characters.');
    expect(passwordProblem('fifteen chars!!')).toBeUndefined();
    const longest =
      'v'.repeat(1) + 'iolet harbour lantern '.repeat(10).slice(0, PASSWORD_MAX_LENGTH - 1);
    expect(passwordLength(longest)).toBe(PASSWORD_MAX_LENGTH);
    expect(passwordProblem(longest)).toBeUndefined();
    expect(passwordProblem(`${longest}x`)).toBe('Use at most 200 characters.');
  });

  it('refuses the passwords people use most, whatever their case', () => {
    expect(COMMON_PASSWORD_LIST.split('\n').length).toBeGreaterThan(10_000);
    for (const common of ['correcthorsebatterystaple', 'PasswordPassword', 'ILOVEYOUILOVEYOU']) {
      expect(passwordProblem(common), common).toBe(
        'This password is one of the most used: choose another one.',
      );
    }
  });

  it('refuses repetitions and sequences, also those no list holds', () => {
    const common = new Set(COMMON_PASSWORD_LIST.split('\n'));
    for (const predictable of [
      'qqqqqqqqqqqqqqqqqqqqqqq',
      'qzqzqzqzqzqzqzqzqzqzqz',
      'k7#mk7#mk7#mk7#mk7#m',
      'ghijklmnopqrstuvwxyz',
      'utsrqponmlkjihgfed',
      '345678901234567890',
    ]) {
      expect(common.has(predictable), `${predictable} is in the list`).toBe(false);
      expect(passwordProblem(predictable), predictable).toBe(
        'This password is too easy to guess: avoid repeated characters and sequences.',
      );
    }
  });

  it("refuses the account's own email or name in it, in any case", () => {
    const context = { email: 'Ada.Lovelace@example.test', name: 'Ada Lovelace' };
    for (const containing of [
      'my name is lovelace and i code',
      'ada.lovelace plus a long tail',
      'ADA.LOVELACE@EXAMPLE.TEST is me',
    ]) {
      expect(passwordProblem(containing, context), containing).toBe(
        'Leave your email address and your name out of your password.',
      );
    }
    // Words of fewer than 4 characters ("Ada") are not checked: too common.
    expect(passwordProblem('the ada bridge at dawn', context)).toBeUndefined();
    expect(passwordProblem(GOOD, context)).toBeUndefined();
  });

  it('judges the NFKC form, the one that is hashed', () => {
    // Fullwidth letters are the same letters once normalized.
    expect(normalizePassword('ｐａｓｓｗｏｒｄｐａｓｓｗｏｒｄ')).toBe('passwordpassword');
    expect(passwordProblem('ｐａｓｓｗｏｒｄｐａｓｓｗｏｒｄ')).toBe(
      'This password is one of the most used: choose another one.',
    );
  });
});

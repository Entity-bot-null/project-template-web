import { describe, expect, it } from 'vitest';
import { emailError, PASSWORD_MAX_LENGTH, passwordError } from './validation';

describe('emailError', () => {
  it('accepts a plausible address, surrounding spaces included', () => {
    expect(emailError(' user@example.com ')).toBeNull();
  });

  it('explains what is wrong', () => {
    expect(emailError('   ')).toBe('Enter your email.');
    expect(emailError('user@')).toBe('Enter a valid email.');
    expect(emailError(`${'a'.repeat(250)}@x.io`)).toBe('Enter a valid email.');
  });
});

describe('passwordError', () => {
  it('requires a password within the server bound', () => {
    expect(passwordError('')).toBe('Enter your password.');
    expect(passwordError('x'.repeat(PASSWORD_MAX_LENGTH))).toBeNull();
    expect(passwordError('x'.repeat(PASSWORD_MAX_LENGTH + 1))).toMatch(/longer than/);
  });
});

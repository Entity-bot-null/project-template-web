// Client-side checks give quick feedback only; the API validates everything
// again and has the final word. Bounds mirror PASSWORD_MAX_LENGTH in
// apps/api/src/auth/auth.constants.ts.
export const PASSWORD_MAX_LENGTH = 200;

export function emailError(email: string): string | null {
  const value = email.trim();
  if (value.length === 0) return 'Enter your email.';
  // The same loose check browsers apply to type="email".
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return 'Enter a valid email.';
  }
  return null;
}

export function passwordError(password: string): string | null {
  if (password.length === 0) return 'Enter your password.';
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `The password cannot be longer than ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}

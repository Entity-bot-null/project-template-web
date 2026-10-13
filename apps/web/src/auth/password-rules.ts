import { characterCount, PASSWORD_MAX_LENGTH } from './validation';

// The rules a new password follows, checked here for quick feedback: they
// mirror apps/api/src/auth/password-policy.ts. The API checks them again,
// plus the list of the most used passwords, which only the server holds (a
// 400 from it means that one). Loaded with the pages that set a password
// only, never in the bundle every visit downloads.

export const PASSWORD_MIN_LENGTH = 15;

export interface PasswordContext {
  email?: string;
  name?: string;
}

export function newPasswordError(password: string, context: PasswordContext = {}): string | null {
  const normalized = password.normalize('NFKC');
  const length = characterCount(normalized);
  if (length === 0) return 'Choose a password.';
  if (length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${String(PASSWORD_MIN_LENGTH)} characters (${String(length)} now).`;
  }
  if (length > PASSWORD_MAX_LENGTH) return `Use at most ${String(PASSWORD_MAX_LENGTH)} characters.`;
  const comparable = normalized.toLowerCase();
  if (isPredictable(comparable)) {
    return 'Too easy to guess: avoid repeated characters and sequences.';
  }
  if (containsAccount(comparable, context)) {
    return 'Leave your email address and your name out of your password.';
  }
  return null;
}

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
    const address = email.trim().normalize('NFKC').toLowerCase();
    words.push(address, address.slice(0, Math.max(0, address.lastIndexOf('@'))));
  }
  if (name !== undefined)
    words.push(
      ...name
        .normalize('NFKC')
        .toLowerCase()
        .split(/[\s\p{P}]+/u),
    );
  return words.some((word) => characterCount(word) >= 4 && comparable.includes(word));
}

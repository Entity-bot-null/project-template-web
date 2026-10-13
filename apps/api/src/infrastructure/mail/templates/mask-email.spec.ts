import { describe, expect, it } from 'vitest';
import { maskEmail } from './mask-email.js';

describe('maskEmail', () => {
  it('keeps the first character of the local part and the domain', () => {
    expect(maskEmail('ada.lovelace@example.com')).toBe('a•••@example.com');
    expect(maskEmail('ñandú@example.es')).toBe('ñ•••@example.es');
  });

  it('shows nothing of something that is not an address', () => {
    expect(maskEmail('@example.com')).toBe('•••');
    expect(maskEmail('no-at-sign')).toBe('•••');
  });
});

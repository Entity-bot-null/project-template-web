/**
 * An address as a notice shows it to another mailbox: the first character
 * of its local part and the domain (ada@example.com → a•••@example.com). The
 * owner recognizes it; a stranger reading the message learns little.
 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${Array.from(address)[0] ?? ''}•••${address.slice(at)}`;
}

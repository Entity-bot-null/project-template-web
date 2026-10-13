// The host names of this machine's loopback interface, as a URL spells them
// (URL.hostname keeps the brackets of an IPv6 literal). Traffic to them never
// leaves the machine, which is why production lets it skip TLS: an SMTP relay
// on the same host, or the production build run locally (the end-to-end
// suite). Exact names only: no other address of 127.0.0.0/8, no *.localhost,
// nothing a resolver could point elsewhere.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether `hostname` (URL.hostname, any letter case) names the loopback interface. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

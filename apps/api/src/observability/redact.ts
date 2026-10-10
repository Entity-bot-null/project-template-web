// Redaction for everything that leaves the process as text: log lines, error
// reports and span attributes all pass through here (docs/security.md#logging).
// Two layers:
//   - a value under a sensitive key ("password", "authorization", "cookie",
//     "apiKey", any "...token...", "...secret...") is replaced whole;
//   - every string is scanned for credentials that appear inline: a database
//     URL with its password in an error message, a bearer token or a JWT in a
//     stack trace, "token=..." in a URL.
// Over-redaction is the safe failure: a masked value costs a lookup, a leaked
// one costs a rotation and an incident.

export const REDACTED = '[REDACTED]';

/** Strings longer than this are cut before scanning: a log line that size is a bug of its own. */
const MAX_TEXT_LENGTH = 64 * 1024;
/** Nesting kept in logged objects; deeper values are summarized. */
const MAX_DEPTH = 8;

const SENSITIVE_KEY =
  /passw(?:or)?d|passphrase|secret|token|authori[sz]ation|cookie|api[-_]?key|private[-_]?key|access[-_]?key|credential|signature|session[-_]?id|^dsn$/i;

/** True when a value stored under this key must never be logged or reported. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

type Rule = readonly [RegExp, string];

// The specific shapes first, the generic key=value rule (below) last. Every
// pattern is linear (bounded repetition before any backtracking point), so a
// long attacker-chosen string cannot stall the logger.
const TEXT_RULES: readonly Rule[] = [
  // PEM private keys, whole.
  [
    /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY-----/g,
    REDACTED,
  ],
  // Credentials in URLs: scheme://user:password@host keeps the user. The
  // password runs to the last "@" before the host: one written unencoded can
  // contain "@" itself.
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/)([^\s:/?#@]{0,256}):([^\s/?#]{1,512})@/gi, `$1$2:${REDACTED}@`],
  // Authorization header values.
  [/\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // JWTs (header and payload are base64url JSON, so both start with eyJ).
  [/\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Well-known provider token formats.
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
];

// key=value, key: value, "key": "value" with a sensitive key: query strings,
// cookie headers, JSON, pretty-printed objects (Prisma errors), and JSON
// serialized inside a JSON string (\"key\":\"value\").
const KEY_VALUE =
  /((?:\\?["'])?)([A-Za-z_][\w.-]{0,63})\1(\s{0,4}[:=]\s{0,4})("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\\"(?:[^"\\]|\\[^"])*\\"|[^\s,;&})\]"']+)/g;
// A quoted value under an ordinary key is scanned too (it can hold a
// serialized body of its own), this many levels deep: bounded work.
const MAX_NESTED_SCANS = 3;

function redactKeyValues(text: string, depth: number): string {
  return text.replace(
    KEY_VALUE,
    (match, quote: string, key: string, separator: string, value: string) => {
      const prefix = `${quote}${key}${quote}${separator}`;
      if (isSensitiveKey(key)) {
        return value.startsWith('[REDACTED') ? match : `${prefix}${quoted(value)}`;
      }
      const mark = quoteOf(value);
      if (mark === '' || depth >= MAX_NESTED_SCANS) return match;
      const inner = value.slice(mark.length, value.length - mark.length);
      return `${prefix}${mark}${redactKeyValues(inner, depth + 1)}${mark}`;
    },
  );
}

/** The quote around a value: `"`, `'`, `\"` (inside a JSON string), or none. */
function quoteOf(value: string): string {
  if (value.startsWith('\\"')) return '\\"';
  const first = value[0];
  return first === '"' || first === "'" ? first : '';
}

function quoted(value: string): string {
  const mark = quoteOf(value);
  return `${mark}${REDACTED}${mark}`;
}

/** Masks the credentials a string carries inline. */
export function redactText(text: string): string {
  let output =
    text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…[truncated]` : text;
  for (const [pattern, replacement] of TEXT_RULES) output = output.replace(pattern, replacement);
  return redactKeyValues(output, 0);
}

/**
 * A copy of `value` safe to log or report: sensitive keys masked at any depth,
 * strings scanned, errors rebuilt with redacted messages and stacks (still
 * `instanceof Error`). Cycles and excessive depth are summarized. The input is
 * never mutated.
 */
export function redact<T>(value: T): T {
  return redactValue(value, 0, new WeakSet()) as T;
}

function redactValue(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (value instanceof Date) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[Binary]';

  ancestors.add(value);
  try {
    if (value instanceof Error) return redactError(value, depth, ancestors);
    if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, ancestors));
    if (value instanceof Map) {
      return new Map(
        [...value].map(([key, item]) => [
          key,
          typeof key === 'string' && isSensitiveKey(key) && item != null
            ? REDACTED
            : redactValue(item, depth + 1, ancestors),
        ]),
      );
    }
    return redactEntries(value, depth, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function redactEntries(
  value: object,
  depth: number,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] =
      isSensitiveKey(key) && item != null ? REDACTED : redactValue(item, depth + 1, ancestors);
  }
  return output;
}

function redactError(error: Error, depth: number, ancestors: WeakSet<object>): Error {
  const cause =
    error.cause === undefined
      ? undefined
      : { cause: redactValue(error.cause, depth + 1, ancestors) };
  const copy =
    error instanceof AggregateError
      ? new AggregateError(
          error.errors.map((item) => redactValue(item, depth + 1, ancestors)),
          redactText(error.message),
          cause,
        )
      : new Error(redactText(error.message), cause);
  copy.name = error.name;
  if (error.stack !== undefined) copy.stack = redactText(error.stack);
  // Own fields such as `code` or `meta` (Prisma) travel with the error.
  Object.assign(copy, redactEntries(error, depth, ancestors));
  return copy;
}

/**
 * A URL as it may be recorded: no credentials, no query string (tokens and
 * personal data travel there), no fragment. Not a URL: redacted as text, with
 * anything after "?" or "#" dropped.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return redactText(url.split(/[?#]/, 1)[0] ?? '');
  }
}

import { describe, expect, it } from 'vitest';
import { isSensitiveKey, REDACTED, redact, redactText, redactUrl } from './redact.js';

// Built at runtime: secret scanners rightly flag a connection string with a
// password written out in a file, test fixtures included.
const PG = 'postgresql';
const dbUrl = (user: string, password: string, rest = '@db:5432/app') =>
  `${PG}://${user}:${password}${rest}`;

// Token-shaped values are built at runtime: secret scanners rightly flag
// literal ones, test fixtures included.
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const JWT = [
  part({ alg: 'HS256', typ: 'JWT' }),
  part({ sub: 'user-1', role: 'admin' }),
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
].join('.');
const AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const API_KEY = ['AbC', '123', 'xyz'].join('');
const STRIPE_KEY = ['sk', 'live', 'abcdefghij1234567890'].join('_');

describe('redactText', () => {
  it.each([
    ['database URL', dbUrl('app', 's3cr3t-pass'), dbUrl('app', REDACTED)],
    [
      'Redis URL without user',
      'rediss://:p4ss-word@cache.internal:6380',
      'rediss://:[REDACTED]@cache.internal:6380',
    ],
    [
      'bearer token',
      'Authorization: Bearer abc.def-123456',
      'Authorization: [REDACTED] [REDACTED]',
    ],
    ['basic credentials', 'header Basic dXNlcjpwYXNzd29yZA==', 'header Basic [REDACTED]'],
    [
      'query string token',
      '/callback?code=1&access_token=abc123&state=x',
      '/callback?code=1&access_token=[REDACTED]&state=x',
    ],
    [
      'cookie header',
      'cookie: refresh_token=r-123; has_session=1',
      'cookie: [REDACTED]; has_session=1',
    ],
    [
      'prefixed cookie',
      '__Host-refresh_token=r-456; Path=/',
      '__Host-refresh_token=[REDACTED]; Path=/',
    ],
    [
      'JSON field',
      '{"email":"a@example.com","password":"hunter2"}',
      '{"email":"a@example.com","password":"[REDACTED]"}',
    ],
    [
      'pretty-printed object',
      'passwordHash: "$argon2id$v=19$m=19456"',
      'passwordHash: "[REDACTED]"',
    ],
    [
      'JSON field inside a JSON string',
      '{"body":"{\\"email\\":\\"a@example.com\\",\\"password\\":\\"hunter2-secret\\"}"}',
      '{"body":"{\\"email\\":\\"a@example.com\\",\\"password\\":\\"[REDACTED]\\"}"}',
    ],
    [
      'key=value inside an ordinary JSON field',
      '{"note":"retry with password=hunter2"}',
      '{"note":"retry with password=[REDACTED]"}',
    ],
    [
      'database URL whose password has an @',
      dbUrl('app', 'p@ss-word-tail'),
      dbUrl('app', REDACTED),
    ],
    ['api key', `apiKey=${API_KEY}`, `apiKey=${REDACTED}`],
    ['provider token', `using ${STRIPE_KEY}`, `using ${REDACTED}`],
    ['GitHub token', `ghp_${'a'.repeat(36)}`, REDACTED],
    ['AWS access key', `key ${AWS_KEY} here`, `key ${REDACTED} here`],
  ])('masks a %s', (_name, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('masks JWTs anywhere in a string', () => {
    expect(redactText(`token was ${JWT}, rejected`)).toBe(`token was ${REDACTED}, rejected`);
  });

  it('masks a private key block', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';
    expect(redactText(`key: ${pem} loaded`)).not.toContain('MIIEvQIBADANBg');
  });

  it('leaves ordinary text alone', () => {
    for (const text of [
      'GET /api/users/7 200 12ms ip=203.0.113.7 user=user-1',
      'Refresh token reuse for user 0190a',
      'Error: connect ECONNREFUSED 127.0.0.1:5432',
      'http://localhost:3000/api/docs',
      'at Object.<anonymous> (file:///app/dist/main.js:10:5)',
    ]) {
      expect(redactText(text)).toBe(text);
    }
  });

  it('stays fast on long hostile input', () => {
    const hostile = `${'a'.repeat(50_000)}=${'b'.repeat(50_000)} ${'token: "'.repeat(5_000)}`;
    // Quotes nested in every style, as deep as the input goes.
    const nested = `a:"b:'c:\\"`.repeat(4_000);
    const started = performance.now();
    redactText(hostile);
    redactText(nested);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('redact', () => {
  it('masks sensitive keys at any depth and keeps the rest', () => {
    const input = {
      user: { id: 'u1', email: 'a@example.com', password: 'x', session: { accessToken: 't' } },
      headers: { authorization: 'Bearer x', cookie: 'c', 'x-request-id': 'r1' },
      list: [{ apiKey: 'k' }, dbUrl('u', 'p', '@h/db')],
    };
    expect(redact(input)).toEqual({
      user: {
        id: 'u1',
        email: 'a@example.com',
        password: REDACTED,
        session: { accessToken: REDACTED },
      },
      headers: { authorization: REDACTED, cookie: REDACTED, 'x-request-id': 'r1' },
      list: [{ apiKey: REDACTED }, dbUrl('u', REDACTED, '@h/db')],
    });
  });

  it('never mutates its input', () => {
    const input = { password: 'x', nested: { token: 'y' } };
    redact(input);
    expect(input).toEqual({ password: 'x', nested: { token: 'y' } });
  });

  it('keeps empty sensitive values readable: null reveals nothing', () => {
    expect(redact({ password: null, token: undefined })).toEqual({
      password: null,
      token: undefined,
    });
  });

  it('rebuilds errors with redacted messages, stacks and fields, still errors', () => {
    const error = Object.assign(new Error(`failed for ${dbUrl('app', 'pw', '@db/app')}`), {
      code: 'P1001',
      meta: { password: 'leak' },
    });
    const result = redact(error);
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBe(error);
    expect(result.message).toBe(`failed for ${dbUrl('app', REDACTED, '@db/app')}`);
    expect(result.stack).not.toContain(':pw@');
    expect(result).toMatchObject({ code: 'P1001', meta: { password: REDACTED } });
  });

  it('follows error causes', () => {
    const error = new Error('outer', { cause: new Error('Bearer abcdef123456') });
    expect((redact(error).cause as Error).message).toBe(`Bearer ${REDACTED}`);
  });

  it('covers maps and aggregate errors too', () => {
    const map = redact(
      new Map<string, unknown>([
        ['token', 't'],
        ['id', 'Bearer abcdef123456'],
      ]),
    );
    expect([...map]).toEqual([
      ['token', REDACTED],
      ['id', `Bearer ${REDACTED}`],
    ]);
    const aggregate = redact(new AggregateError([new Error('password=x')], 'two failed'));
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate.errors[0] as Error).message).toBe(`password=${REDACTED}`);
  });

  it('survives cycles, deep nesting and binary data', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({ name: 'loop', self: '[Circular]' });

    let deep: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 20; level += 1) deep = { deep };
    expect(JSON.stringify(redact(deep))).toContain('[Truncated]');

    expect(redact({ data: Buffer.from('secret') })).toEqual({ data: '[Binary]' });
  });
});

describe('isSensitiveKey', () => {
  it('recognizes credential-like names in any style', () => {
    for (const key of [
      'password',
      'passwordHash',
      'PASSWD',
      'clientSecret',
      'refresh_token',
      'tokenHash',
      'Authorization',
      'set-cookie',
      'x-api-key',
      'privateKey',
      'sessionId',
      'dsn',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ['id', 'email', 'userId', 'requestId', 'path', 'statusCode', 'key', 'role']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe('redactUrl', () => {
  it('keeps scheme, host and path only', () => {
    expect(redactUrl('https://user:pw@api.example.com/v1/items?token=abc#frag')).toBe(
      'https://api.example.com/v1/items',
    );
    expect(redactUrl('/relative/path?secret=1')).toBe('/relative/path');
  });
});

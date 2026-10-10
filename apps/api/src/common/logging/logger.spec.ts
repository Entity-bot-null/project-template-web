import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithRequestContext } from '../../observability/request-context.js';
import { createLogger } from './logger.js';

const identity = { APP_ENVIRONMENT: 'staging', APP_RELEASE: 'abc1234', OTEL_SERVICE_NAME: 'api' };

function captureOutput() {
  const lines: string[] = [];
  const capture = (chunk: string | Uint8Array) => {
    lines.push(chunk.toString());
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  return lines;
}

const json = () => createLogger({ ...identity, LOG_LEVEL: 'log', LOG_FORMAT: 'json' });
const text = () => createLogger({ ...identity, LOG_LEVEL: 'log', LOG_FORMAT: 'text' });

// Built at runtime: secret scanners rightly flag a connection string with a
// password written out in a file, test fixtures included.
const PG = 'postgresql';
const dbUrl = (user: string, password: string, rest = '@db:5432/app') =>
  `${PG}://${user}:${password}${rest}`;

function entries(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A JWT-shaped value, built at runtime: secret scanners rightly flag a literal one. */
function fakeJwt(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [part({ alg: 'HS256' }), part({ sub: 'user-1' }), 'c2lnbmF0dXJlLXNpZ25hdHVyZQ'].join('.');
}

// Values a careless log call could hand over; none may reach the output.
const SECRETS = {
  password: 'hunter2-correct-horse',
  token: fakeJwt(),
  dbPassword: 'db-pass-9f8e7d',
  cookie: 'refresh-cookie-value-1234',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('writes one JSON object per line, with the deployment identity', () => {
    const lines = captureOutput();
    json().log({ message: 'hello', requestId: 'r1' });
    expect(lines).toHaveLength(1);
    expect(entries(lines)[0]).toMatchObject({
      level: 'log',
      message: { message: 'hello', requestId: 'r1' },
      service: 'api',
      environment: 'staging',
      release: 'abc1234',
    });
  });

  it('adds the id of the request being served to every line written for it', () => {
    const lines = captureOutput();
    runWithRequestContext({ requestId: 'req-42' }, () => {
      json().warn('inside a request');
    });
    json().warn('outside');
    const [inside, outside] = entries(lines);
    expect(inside).toMatchObject({ requestId: 'req-42' });
    expect(outside).not.toHaveProperty('requestId');
  });

  it('names the request in text lines too', () => {
    const lines = captureOutput();
    runWithRequestContext({ requestId: 'req-7' }, () => {
      text().log('working', 'UsersService');
    });
    // eslint-disable-next-line no-control-regex -- strips the terminal colors of text mode
    const plain = lines.join('').replace(/\u001b\[\d+m/g, '');
    expect(plain).toContain('[UsersService] (req req-7) working');
  });

  it('drops levels less severe than LOG_LEVEL', () => {
    const lines = captureOutput();
    const logger = createLogger({ ...identity, LOG_LEVEL: 'warn', LOG_FORMAT: 'text' });
    logger.debug('hidden');
    logger.log('hidden');
    logger.warn('shown');
    logger.error('shown too');
    expect(lines.join('')).not.toContain('hidden');
    expect(lines.join('')).toContain('shown');
    expect(lines.join('')).toContain('shown too');
  });

  describe.each([
    ['json', json],
    ['text', text],
  ])('redaction (%s)', (_format, create) => {
    it('masks sensitive keys in logged objects and structured params', () => {
      const lines = captureOutput();
      create().log({ user: 'u1', password: SECRETS.password, headers: { cookie: SECRETS.cookie } });
      create().warn('sign-in attempt', { accessToken: SECRETS.token });
      const output = lines.join('');
      expect(output).toContain('u1');
      expect(output).toContain('[REDACTED]');
      for (const secret of Object.values(SECRETS)) expect(output).not.toContain(secret);
    });

    it('masks credentials inside plain strings, errors and stack traces', () => {
      const lines = captureOutput();
      const error = new Error(
        `connect failed for ${dbUrl('app', SECRETS.dbPassword)} with Bearer ${SECRETS.token}`,
      );
      create().error('Query failed', error.stack);
      create().error(error);
      create().log(`set-cookie: refresh_token=${SECRETS.cookie}; Path=/`);
      const output = lines.join('');
      expect(output).toContain(dbUrl('app', '[REDACTED]'));
      for (const secret of Object.values(SECRETS)) expect(output).not.toContain(secret);
    });
  });
});

describe('lazy (function) messages', () => {
  it('redacts what the function returns, in both formats', () => {
    const lines = captureOutput();
    json().log(() => `connect failed for ${dbUrl('app', SECRETS.dbPassword)}`, 'Lazy');
    text().warn(() => `upstream rejected Bearer ${SECRETS.token}`, 'Lazy');
    const output = lines.join('');
    expect(output).toContain(dbUrl('app', '[REDACTED]'));
    expect(output).not.toContain(SECRETS.dbPassword);
    expect(output).not.toContain(SECRETS.token);
  });
});

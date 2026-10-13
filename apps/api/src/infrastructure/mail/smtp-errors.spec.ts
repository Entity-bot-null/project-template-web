import { describe, expect, it } from 'vitest';
import { classifyDeliveryError } from './smtp-errors.js';

// The shapes below are what nodemailer throws (checked against Mailpit's
// chaos mode: a "451" and a "550" from RCPT TO both arrive as EENVELOPE).
const smtpError = (code: string, responseCode?: number) =>
  Object.assign(new Error('server text that may quote victim@example.test'), {
    code,
    responseCode,
  });

describe('classifyDeliveryError', () => {
  it('reads the SMTP reply code first: 4xx is transient, 5xx permanent, whatever the error code', () => {
    expect(classifyDeliveryError(smtpError('EENVELOPE', 451))).toEqual({
      category: 'smtp_4xx_451',
      permanent: false,
      configuration: false,
    });
    expect(classifyDeliveryError(smtpError('EENVELOPE', 550))).toEqual({
      category: 'smtp_5xx_550',
      permanent: true,
      configuration: false,
    });
    expect(classifyDeliveryError(smtpError('EMESSAGE', 421))).toMatchObject({ permanent: false });
    expect(classifyDeliveryError(smtpError('EMESSAGE', 554))).toMatchObject({ permanent: true });
  });

  it('treats a refused login as configuration, not as the message: it waits for the fix', () => {
    for (const responseCode of [530, 534, 535, 538, 454]) {
      expect(classifyDeliveryError(smtpError('EAUTH', responseCode))).toMatchObject({
        permanent: false,
        configuration: true,
      });
    }
    expect(classifyDeliveryError(smtpError('EAUTH'))).toEqual({
      category: 'auth',
      permanent: false,
      configuration: true,
    });
    expect(classifyDeliveryError(smtpError('ETLS'))).toEqual({
      category: 'tls',
      permanent: false,
      configuration: true,
    });
  });

  it('retries what failed on the way: connection, timeout, DNS', () => {
    for (const code of ['ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET']) {
      expect(classifyDeliveryError(smtpError(code))).toEqual({
        category: 'connection',
        permanent: false,
        configuration: false,
      });
    }
    expect(classifyDeliveryError(smtpError('ETIMEDOUT')).category).toBe('timeout');
    expect(classifyDeliveryError(smtpError('EDNS')).category).toBe('dns');
  });

  it('gives up on a message refused before any server saw it', () => {
    expect(classifyDeliveryError(smtpError('EENVELOPE'))).toEqual({
      category: 'invalid_address',
      permanent: true,
      configuration: false,
    });
    expect(classifyDeliveryError(smtpError('EMESSAGE')).category).toBe('invalid_message');
  });

  it('retries anything unknown, and never carries the server text in the category', () => {
    for (const error of [new Error('boom'), 'a string', null, undefined, { responseCode: 'x' }]) {
      expect(classifyDeliveryError(error)).toEqual({
        category: 'unknown',
        permanent: false,
        configuration: false,
      });
    }
    expect(classifyDeliveryError(smtpError('EENVELOPE', 999)).category).toBe('invalid_address');
    expect(JSON.stringify(classifyDeliveryError(smtpError('EENVELOPE', 550)))).not.toContain(
      'example.test',
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailOptions } from './mail.types.js';

const nodemailer = vi.hoisted(() => {
  const sendMail = vi.fn(() => Promise.resolve({}));
  const close = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, close }));
  return { sendMail, close, createTransport };
});
vi.mock('nodemailer', () => ({ default: { createTransport: nodemailer.createTransport } }));

const { createSmtpTransport, smtpSettings } = await import('./mail.transport.js');

const options: MailOptions = {
  smtpUrl: 'smtp://localhost:1035',
  from: { name: 'Acme', address: 'no-reply@acme.test' },
  appOrigin: 'https://app.acme.test',
  maxAttempts: 8,
  dailyLimitPerAddress: 10,
  production: false,
  recipientKey: Buffer.alloc(32),
};

beforeEach(() => {
  nodemailer.sendMail.mockClear();
  nodemailer.createTransport.mockClear();
});

describe('smtpSettings', () => {
  it('uses STARTTLS on smtp:// (587 by default), and requires it in production', () => {
    expect(smtpSettings('smtp://smtp.acme.test', false)).toMatchObject({
      host: 'smtp.acme.test',
      port: 587,
      secure: false,
      requireTLS: false,
    });
    expect(smtpSettings('smtp://smtp.acme.test', true)).toMatchObject({ requireTLS: true });
  });

  it('uses TLS from the first byte on smtps:// (465 by default)', () => {
    expect(smtpSettings('smtps://smtp.acme.test', true)).toMatchObject({
      port: 465,
      secure: true,
      requireTLS: false,
    });
  });

  it('decodes percent-encoded credentials, and sends none when the URL has none', () => {
    expect(smtpSettings('smtp://us%40er:p%40ss%2Fw@smtp.acme.test:2525', true)).toMatchObject({
      port: 2525,
      auth: { user: 'us@er', pass: 'p@ss/w' },
    });
    expect(smtpSettings('smtp://localhost:1035', false)).not.toHaveProperty('auth');
  });

  it('connects to an IPv6 literal without its brackets', () => {
    expect(smtpSettings('smtp://[::1]:1035', false).host).toBe('::1');
  });

  it('bounds every wait, requires TLS 1.2+ and never lets a message read files or URLs', () => {
    expect(smtpSettings('smtp://localhost:1035', false)).toMatchObject({
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      tls: { minVersion: 'TLSv1.2' },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  });
});

describe('createSmtpTransport', () => {
  it('sends with the configured sender, a stable Message-ID and the auto-generated headers', async () => {
    const transport = createSmtpTransport(options);
    await transport.send({
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      to: 'ada@example.test',
      subject: 'Hello',
      text: 'text',
      html: '<p>html</p>',
    });
    expect(nodemailer.sendMail).toHaveBeenCalledWith({
      from: { name: 'Acme', address: 'no-reply@acme.test' },
      to: 'ada@example.test',
      subject: 'Hello',
      text: 'text',
      html: '<p>html</p>',
      messageId: '<0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b@acme.test>',
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    });
    transport.close();
    expect(nodemailer.close).toHaveBeenCalledOnce();
  });

  it('passes on what the server answered', async () => {
    nodemailer.sendMail.mockRejectedValueOnce(Object.assign(new Error('x'), { responseCode: 451 }));
    await expect(
      createSmtpTransport(options).send({ id: 'i', to: 't', subject: 's', text: 't', html: 'h' }),
    ).rejects.toMatchObject({ responseCode: 451 });
  });

  it('refuses to start without a server or a sender', () => {
    expect(() => createSmtpTransport({ ...options, smtpUrl: undefined })).toThrow(
      'Email is not configured',
    );
    expect(() => createSmtpTransport({ ...options, from: undefined })).toThrow(
      'Email is not configured',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { isLoopbackHost } from './loopback.js';

describe('isLoopbackHost', () => {
  it('knows the loopback names as URL.hostname spells them', () => {
    for (const url of ['http://localhost:4173', 'smtp://127.0.0.1:1035', 'smtp://[::1]:1035']) {
      expect(isLoopbackHost(new URL(url).hostname), url).toBe(true);
    }
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
  });

  it('refuses every other host, look-alikes included', () => {
    for (const host of [
      'app.example.com',
      '127.0.0.2',
      '0.0.0.0',
      'localhost.example.com',
      'evil.localhost',
      '[::ffff:127.0.0.1]',
      '',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

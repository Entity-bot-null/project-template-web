import { randomInt } from 'node:crypto';
import { test as base } from '@playwright/test';

// Every test is its own client. The API counts its per-IP limits (10
// sign-ins a minute, for one) by the address the preview server's proxy
// forwards (TRUST_PROXY=loopback reads X-Forwarded-For from it only), and the
// whole suite runs from this machine: as one client it would spend them in
// a few tests. Each test gets an address of the benchmarking range (RFC 2544,
// 198.18.0.0/15, never routed), so the limits still apply, per test, as they
// do per person. The limits themselves are tested by the integration specs.
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
    await use({
      ...extraHTTPHeaders,
      'X-Forwarded-For': `198.18.${String(randomInt(256))}.${String(randomInt(1, 255))}`,
    });
  },
});

export { expect } from '@playwright/test';

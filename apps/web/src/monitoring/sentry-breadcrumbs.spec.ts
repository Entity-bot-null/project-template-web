import { close, getClient } from '@sentry/browser';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resetCapabilitiesForTests } from '../auth/capabilities';
import { resetForTests, setSession } from '../auth/session';
import { admin } from '../test/fixtures';
import { deferred, ok, stubFetch } from '../test/http';
import { renderRoute } from '../test/render';
import { initSentry } from './sentry';

// The real SDK (sentry.spec.ts mocks it): what its own DOM instrumentation
// records, once scrubbed, in the envelope it would send.

const pending = {
  id: '0190b6a1-0000-7000-8000-0000000000c1',
  email: 'katherine@example.com',
  role: 'member',
  invitedBy: { id: admin.id, name: admin.name },
  createdAt: '2026-10-13T10:00:00.000Z',
  expiresAt: '2026-10-20T10:00:00.000Z',
};

beforeEach(() => {
  resetForTests();
  resetCapabilitiesForTests();
  setSession({ accessToken: 'admin-token', expiresIn: 900, user: admin });
});
afterEach(async () => {
  resetForTests();
  await close(0);
});

it('sends no invitee address when an admin clicks a row action', async () => {
  const held = deferred<Response>();
  stubFetch({
    'GET /api/auth/capabilities': () =>
      ok({ passwordReset: true, signUp: false, emailChange: true, invitations: true }),
    'GET /api/admin/invitations': () => ok({ items: [pending], total: 1 }),
    'POST /api/admin/invitations': () => held.promise,
  });
  renderRoute('/admin/invitations');
  // The page first, then the SDK: its DOM instrumentation only has to be on
  // before the click, and the page's lazy chunk and list load under the
  // whole suite's load, hence the explicit wait.
  const resend = await screen.findByRole(
    'button',
    { name: `Send again to ${pending.email}` },
    { timeout: 10_000 },
  );
  // A loopback DSN on a closed port: nothing leaves the machine.
  const report = initSentry({
    dsn: 'http://public@127.0.0.1:9/1',
    environment: 'test',
    release: 'spec',
    sampleRate: 1,
  });
  const envelopes: string[] = [];
  getClient()?.on('beforeEnvelope', (envelope) => {
    envelopes.push(JSON.stringify(envelope));
  });

  await userEvent.setup().click(resend);
  // Any later unexpected error on the page carries the breadcrumbs with it.
  report(new Error('Something broke later'), { source: 'window' });
  await expect.poll(() => envelopes.length).toBeGreaterThan(0);

  const sent = envelopes.join('\n');
  expect(sent).toContain('"category":"ui.click"');
  expect(sent).not.toContain(pending.email);
}, 20_000);

import { describe, expect, it } from 'vitest';
import type { Prisma } from '../../../prisma/generated/client.js';
import type { ClaimedMessage } from '../mail.types.js';
import { escapeHtml, renderMail } from './layout.js';
import { appUrl, productName } from './registry.js';
import { testTemplate } from './test.template.js';

const content = {
  subject: 'Reset your password',
  heading: 'Reset <your> password',
  paragraphs: ['Hello "Ada" & friends', "It's quick."],
  action: { label: 'Choose a new password', url: 'https://app.example.test/reset#token=a&b' },
  footer: ['If you did not ask for this, ignore it.'],
};

describe('renderMail', () => {
  it('escapes every value in the HTML, quotes and ampersands of the link included', () => {
    const { html } = renderMail(content, 'Acme <Corp>');
    expect(html).toContain('Reset &lt;your&gt; password');
    expect(html).toContain('Hello &quot;Ada&quot; &amp; friends');
    expect(html).toContain('It&#39;s quick.');
    expect(html).toContain('href="https://app.example.test/reset#token=a&amp;b"');
    expect(html).toContain('Acme &lt;Corp&gt;');
    expect(html).not.toContain('<your>');
    expect(html).not.toContain('<Corp>');
  });

  it('writes a plain-text part with the link in full, for clients that show no HTML', () => {
    const { text } = renderMail(content, 'Acme');
    expect(text).toContain('Reset <your> password');
    expect(text).toContain('Choose a new password: https://app.example.test/reset#token=a&b');
    expect(text.trimEnd().endsWith('Acme')).toBe(true);
  });

  it('loads nothing remote: no image, stylesheet or font a third party could see opened', () => {
    const { html } = renderMail(content, 'Acme');
    expect(html).not.toMatch(/<img|<link|<script|@import|url\(/i);
    // The only addresses in it are the action's own.
    const urls = html.match(/https?:\/\/[^"<\s]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set(['https://app.example.test/reset#token=a&amp;b']));
  });

  it('keeps the subject on one line, so no header can be injected through a value in it', () => {
    expect(renderMail({ ...content, subject: 'Hi\r\nBcc: x@example.test\n' }, 'Acme').subject).toBe(
      'Hi Bcc: x@example.test',
    );
  });

  it('renders a message without an action', () => {
    const { action: _action, ...withoutAction } = content;
    const { html, text } = renderMail(withoutAction, 'Acme');
    expect(html).not.toContain('<a ');
    expect(text).not.toContain('https://');
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that matter in text and attributes', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('productName', () => {
  it("is the sender's display name, else the public host", () => {
    expect(
      productName({ from: { name: 'Acme', address: 'a@acme.test' }, appOrigin: undefined }),
    ).toBe('Acme');
    expect(
      productName({ from: { address: 'a@acme.test' }, appOrigin: 'https://app.acme.test:8443' }),
    ).toBe('app.acme.test:8443');
    expect(productName({ from: undefined, appOrigin: undefined })).toBe('the app');
  });
});

describe('appUrl', () => {
  it("is the web app's address: its origin, then its path when it has one", () => {
    expect(appUrl('https://app.acme.test', '/app')).toBe('https://app.acme.test/app');
    expect(appUrl('https://app.acme.test:8443', '/portal/v2')).toBe(
      'https://app.acme.test:8443/portal/v2',
    );
    expect(appUrl('https://app.acme.test', '/')).toBe('https://app.acme.test');
  });
});

describe('the test template', () => {
  it('names the message and the product, links nowhere, and is not limited (an operator sends it)', async () => {
    const message: ClaimedMessage = {
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      kind: 'test',
      recipient: 'ops@example.test',
      userId: null,
      payload: {},
      attempts: 1,
      claimId: 'claim-1',
      expiresAt: new Date('2026-10-13T12:00:00Z'),
      createdAt: new Date('2026-10-13T11:00:00Z'),
      requestId: null,
    };
    const rendered = await testTemplate.compose({
      tx: {} as Prisma.TransactionClient,
      message,
      product: 'Acme',
      appUrl: 'https://app.acme.test/app',
    });
    expect(rendered?.subject).toBe('Test message from Acme');
    expect(rendered?.text).toContain(message.id);
    expect(rendered?.text).toContain('2026-10-13T11:00:00.000Z');
    expect(rendered?.html).not.toContain('<a ');
    expect(testTemplate.limited).toBe(false);
    expect(testTemplate.ttlMs).toBe(3_600_000);
  });
});

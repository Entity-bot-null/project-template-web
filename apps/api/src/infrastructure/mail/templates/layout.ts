// Every message has the same shape: a heading, a few paragraphs, at most one
// action, a footer; sent as HTML and as plain text. The HTML has no remote
// resource (no image, font or stylesheet to fetch: nothing tells a third
// party a message was opened) and every value in it is escaped.

export interface MailContent {
  subject: string;
  heading: string;
  paragraphs: string[];
  /** One button, its URL also written out in full for clients without links. */
  action?: { label: string; url: string };
  /** Why the reader got this message, and what to do if it was not them. */
  footer: string[];
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** Headers allow no line breaks: a subject carries none, whatever a value in it held. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function renderMail(content: MailContent, product: string): RenderedMail {
  const subject = singleLine(content.subject);
  const text = [
    content.heading,
    '',
    ...content.paragraphs.flatMap((paragraph) => [paragraph, '']),
    ...(content.action ? [`${content.action.label}: ${content.action.url}`, ''] : []),
    '--',
    ...content.footer,
    product,
  ].join('\n');

  const paragraph = (value: string) =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.5">${escapeHtml(value)}</p>`;
  const action = content.action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(content.action.url)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#1d4ed8;color:#ffffff;font-weight:600;text-decoration:none">${escapeHtml(content.action.label)}</a></p>` +
      paragraph('If the button does not work, copy this address into your browser:') +
      `<p style="margin:0 0 16px;font-size:14px;word-break:break-all"><a href="${escapeHtml(content.action.url)}" style="color:#1d4ed8">${escapeHtml(content.action.url)}</a></p>`
    : '';
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(subject)}</title>`,
    '</head>',
    '<body style="margin:0;padding:24px;background:#f4f4f5;color:#18181b;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">',
    '<div style="max-width:560px;margin:0 auto;padding:32px;border-radius:8px;background:#ffffff">',
    `<h1 style="margin:0 0 24px;font-size:22px;line-height:1.3">${escapeHtml(content.heading)}</h1>`,
    ...content.paragraphs.map(paragraph),
    action,
    '<hr style="margin:32px 0 16px;border:none;border-top:1px solid #e4e4e7">',
    ...content.footer.map(
      (line) =>
        `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#52525b">${escapeHtml(line)}</p>`,
    ),
    `<p style="margin:0;font-size:13px;color:#52525b">${escapeHtml(product)}</p>`,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
  return { subject, text, html };
}

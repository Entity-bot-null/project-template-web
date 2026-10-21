// The box `pnpm dev` prints under the servers' logs once they are up
// (scripts/dev.mjs): where the landing, the app, the API, its docs, the
// database and the mail catcher are. Read from the settings those processes read (apps/api/.env,
// DB_PORT, MAILPIT_*), so it shows what runs, not what the defaults would be;
// email's state is what the API's readiness probe answered.
//
//   node scripts/dev-banner.mjs     print it
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnv, styleText } from 'node:util';

// apps/web/vite.config.ts and apps/landing/astro.config.mjs: server.port, with
// strictPort (the dev server fails rather than move to another port).
const WEB_PORT = '5173';
const LANDING_PORT = '4321';
// docker-compose.yml: the ports the db and mailpit services publish without
// DB_PORT, MAILPIT_SMTP_PORT and MAILPIT_UI_PORT.
export const DEFAULT_DB_PORT = '5442';
export const DEFAULT_MAILPIT_SMTP_PORT = '1035';
export const DEFAULT_MAILPIT_UI_PORT = '8035';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {'ok' | 'degraded' | 'disabled'} MailStatus what readiness said (checks.mail)
 * @typedef {{ landing: string; web: string; api: string; docs: string; database?: string; mail: string; warnings: string[] }} Settings
 */

/**
 * The addresses of the development stack.
 * @param {{ api: Env; compose: Env }} sources the API's settings (apps/api/.env
 *   under the environment, as the API reads them) and the variables Compose
 *   reads for the published ports (the root .env under the environment)
 * @returns {Settings}
 */
export function devSettings({ api, compose }) {
  // Outside production the API listens on loopback (apps/api/src/env/env.schema.ts).
  const host = api.HOST || '127.0.0.1';
  const apiUrl = `http://${host.includes(':') ? `[${host}]` : host}:${api.PORT || '3000'}/api`;
  const mail = mailSettings(api, compose);
  const settings = {
    landing: `http://localhost:${LANDING_PORT}`,
    web: `http://localhost:${WEB_PORT}`,
    api: apiUrl,
    docs: `${apiUrl}/docs`,
    mail: mail.value,
  };
  if (!api.DATABASE_URL) {
    return {
      ...settings,
      warnings: [
        'DATABASE_URL is not set: copy apps/api/.env.example to apps/api/.env',
        ...mail.warnings,
      ],
    };
  }
  const url = new URL(api.DATABASE_URL);
  const port = url.port || '5432';
  const published = compose.DB_PORT || DEFAULT_DB_PORT;
  return {
    ...settings,
    // Host, port and database only: never the credentials.
    database: `${url.hostname}:${port}${url.pathname}`,
    warnings: [
      ...(LOOPBACK.has(url.hostname) && port !== published
        ? [
            `DATABASE_URL uses port ${port}, but pnpm db:up publishes ${published} (DB_PORT): set the same port in both`,
          ]
        : []),
      ...mail.warnings,
    ],
  };
}

/**
 * Where messages go: Mailpit's web UI when MAIL_SMTP_URL is the local
 * Mailpit, else the SMTP server (host and port, never its credentials).
 * @param {Env} api
 * @param {Env} compose
 * @returns {{ value: string; warnings: string[] }}
 */
function mailSettings(api, compose) {
  if (!api.MAIL_SMTP_URL) {
    return { value: 'off (set MAIL_SMTP_URL in apps/api/.env)', warnings: [] };
  }
  if (!URL.canParse(api.MAIL_SMTP_URL)) return { value: 'invalid MAIL_SMTP_URL', warnings: [] };
  const url = new URL(api.MAIL_SMTP_URL);
  const port = url.port || (url.protocol === 'smtps:' ? '465' : '587');
  const smtpPort = compose.MAILPIT_SMTP_PORT || DEFAULT_MAILPIT_SMTP_PORT;
  if (!LOOPBACK.has(url.hostname)) return { value: `${url.protocol}//${url.host}`, warnings: [] };
  if (port === smtpPort) {
    return {
      value: `http://localhost:${compose.MAILPIT_UI_PORT || DEFAULT_MAILPIT_UI_PORT} (Mailpit)`,
      warnings: [],
    };
  }
  // Another local SMTP server on that port (another project's Mailpit, say)
  // would receive this project's messages without anyone noticing.
  return {
    value: `${url.protocol}//${url.host}`,
    warnings: [
      `MAIL_SMTP_URL uses port ${port}, but pnpm services:up publishes Mailpit on ${smtpPort} (MAILPIT_SMTP_PORT): set the same port in both`,
    ],
  };
}

/**
 * The box, one string, and the warnings under it (outside, so a long one does
 * not widen the box). `style` colors a part (util.styleText, which leaves the
 * text plain when the output is not a terminal or NO_COLOR is set).
 * @param {Settings} settings
 * @param {{ name: string; version: string }} app
 * @param {(format: Parameters<typeof styleText>[0], text: string) => string} [style]
 * @param {MailStatus} [mailStatus] what the API's readiness said about email
 */
export function renderBanner(settings, app, style = styleText, mailStatus = undefined) {
  const mail =
    mailStatus === undefined || mailStatus === 'disabled'
      ? settings.mail
      : `${settings.mail} · ${mailStatus}`;
  const rows = [
    ['Landing', settings.landing],
    ['Web', settings.web],
    ['API', settings.api],
    ['API docs', settings.docs],
    ...(settings.database ? [['Database', settings.database]] : []),
    ['Mail', mail],
  ];
  const labelWidth = Math.max(...rows.map(([label = '']) => label.length));
  const title = `${app.name} ${app.version} · development`;
  /** @type {[plain: string, styled: string][]} */
  const lines = [
    ['', ''],
    [title, style('bold', title)],
    ['', ''],
    ...rows.map(([label = '', value = '']) => {
      const name = label.padEnd(labelWidth);
      return /** @type {[string, string]} */ ([
        `➜  ${name}   ${value}`,
        `${style('green', '➜')}  ${style('bold', name)}   ${style('cyan', value)}`,
      ]);
    }),
    ['', ''],
  ];
  const width = Math.max(...lines.map(([plain]) => plain.length));
  const edge = style('dim', '─'.repeat(width + 6));
  const side = style('dim', '│');
  return [
    `${style('dim', '╭')}${edge}${style('dim', '╮')}`,
    ...lines.map(
      ([plain, styled]) => `${side}   ${styled}${' '.repeat(width - plain.length)}   ${side}`,
    ),
    `${style('dim', '╰')}${edge}${style('dim', '╯')}`,
    ...(settings.warnings.length > 0 ? [''] : []),
    ...settings.warnings.map((warning) => style('yellow', `!  ${warning}`)),
  ]
    .map((line) => (line ? `  ${line}` : line))
    .join('\n');
}

/** @param {URL} file */
function readEnv(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

/** The settings as they are now: read again after each restart of the API. */
export function currentSettings() {
  const root = new URL('../', import.meta.url);
  // The environment wins over a .env file, for the API (process.loadEnvFile)
  // as for Compose.
  return devSettings({
    api: { ...readEnv(new URL('apps/api/.env', root)), ...process.env },
    compose: { ...readEnv(new URL('.env', root)), ...process.env },
  });
}

/**
 * The box for the current settings.
 * @param {MailStatus} [mailStatus]
 */
export function currentBanner(mailStatus = undefined) {
  const app = /** @type {{ name: string; version: string }} */ (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  );
  return renderBanner(currentSettings(), app, styleText, mailStatus);
}

const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isCli) console.log(`\n${currentBanner()}\n`);

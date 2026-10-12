// The box `pnpm dev` prints under the API and web logs once both are up
// (scripts/dev.mjs): where the app, the API, its docs and the database are.
// Read from the settings those processes read (apps/api/.env, DB_PORT), so it
// shows what runs, not what the defaults would be.
//
//   node scripts/dev-banner.mjs     print it
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnv, styleText } from 'node:util';

// apps/web/vite.config.ts: server.port, with strictPort (Vite fails rather
// than move to another port).
const WEB_PORT = '5173';
// docker-compose.yml: the port the db service publishes without DB_PORT.
export const DEFAULT_DB_PORT = '5442';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ web: string; api: string; docs: string; database?: string; warning?: string }} Settings
 */

/**
 * The addresses of the development stack.
 * @param {{ api: Env; compose: Env }} sources the API's settings (apps/api/.env
 *   under the environment, as the API reads them) and the variables Compose
 *   reads for the database port (the root .env under the environment)
 * @returns {Settings}
 */
export function devSettings({ api, compose }) {
  // Outside production the API listens on loopback (apps/api/src/env/env.schema.ts).
  const host = api.HOST || '127.0.0.1';
  const apiUrl = `http://${host.includes(':') ? `[${host}]` : host}:${api.PORT || '3000'}/api`;
  const settings = { web: `http://localhost:${WEB_PORT}`, api: apiUrl, docs: `${apiUrl}/docs` };
  if (!api.DATABASE_URL) {
    return {
      ...settings,
      warning: 'DATABASE_URL is not set: copy apps/api/.env.example to apps/api/.env',
    };
  }
  const url = new URL(api.DATABASE_URL);
  const port = url.port || '5432';
  const published = compose.DB_PORT || DEFAULT_DB_PORT;
  return {
    ...settings,
    // Host, port and database only: never the credentials.
    database: `${url.hostname}:${port}${url.pathname}`,
    ...(LOOPBACK.has(url.hostname) && port !== published
      ? {
          warning: `DATABASE_URL uses port ${port}, but pnpm db:up publishes ${published} (DB_PORT): set the same port in both`,
        }
      : {}),
  };
}

/**
 * The box, one string, and the warning under it (outside, so a long one does
 * not widen the box). `style` colors a part (util.styleText, which leaves the
 * text plain when the output is not a terminal or NO_COLOR is set).
 * @param {Settings} settings
 * @param {{ name: string; version: string }} app
 * @param {(format: Parameters<typeof styleText>[0], text: string) => string} [style]
 */
export function renderBanner(settings, app, style = styleText) {
  const rows = [
    ['Web', settings.web],
    ['API', settings.api],
    ['API docs', settings.docs],
    ...(settings.database ? [['Database', settings.database]] : []),
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
    ...(settings.warning ? ['', style('yellow', `!  ${settings.warning}`)] : []),
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

/** The box for the current settings. */
export function currentBanner() {
  const app = /** @type {{ name: string; version: string }} */ (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  );
  return renderBanner(currentSettings(), app);
}

const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isCli) console.log(`\n${currentBanner()}\n`);

// Tests of the development proxies in apps/web/vite.config.ts and
// apps/landing/astro.config.mjs (`node --test scripts/dev-proxy.test.mjs`): the
// real dev servers, with the apps' own configurations, in front of stand-ins
// for the API and the web app that record what reaches them. A browser that
// sends no Fetch Metadata (Safari before 16.4, and any browser on a page over
// plain HTTP from a non-local address: a phone on the LAN testing the dev
// server) passes the API's CSRF guard only when its Origin is the address the
// request was sent to, read from Host
// (apps/api/src/common/guards/fetch-metadata.guard.ts). So a proxy must hand
// the API the Host the browser sent, not the API's own address.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEB = fileURLToPath(new URL('../apps/web/', import.meta.url));
/**
 * The part of a Vite dev server this test uses (Vite is the web app's
 * dependency, resolved from there, so its types are not visible here).
 * @typedef {{
 *   listen(): Promise<unknown>;
 *   close(): Promise<void>;
 *   httpServer: import('node:http').Server | null;
 * }} DevServer
 */
/** @type {{ createServer(config: object): Promise<DevServer> }} */
const vite = await import(
  pathToFileURL(createRequire(join(WEB, 'package.json')).resolve('vite')).href
);

/** @type {{ host?: string; origin?: string; url?: string }[]} */
const received = [];
const api = createHttpServer((req, res) => {
  received.push({ host: req.headers.host, origin: req.headers.origin, url: req.url });
  res.writeHead(204).end();
});
/** @type {DevServer} */
let dev;
let port = 0;

before(async () => {
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const address = api.address();
  assert.ok(address !== null && typeof address === 'object');
  // Read by vite.config.ts when the configuration loads.
  process.env.API_PROXY_TARGET = `http://127.0.0.1:${address.port}`;
  dev = await vite.createServer({
    configFile: join(WEB, 'vite.config.ts'),
    root: WEB,
    logLevel: 'silent',
    // An address the request below can reach whatever localhost resolves to.
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  await dev.listen();
  const devAddress = dev.httpServer?.address();
  assert.ok(devAddress !== null && typeof devAddress === 'object');
  port = devAddress.port;
});

after(async () => {
  await dev.close();
  api.close();
});

/**
 * A POST through the dev server, as a browser at `host` sends it.
 * @param {string} host
 * @returns {Promise<number | undefined>}
 */
function postThroughDevServer(host) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/auth/refresh',
        headers: { Host: host, Origin: `http://${host}` },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

for (const { where, host } of [
  { where: 'on this machine', host: () => `localhost:${port}` },
  {
    where: 'from another device on the network (dev server started with --host)',
    host: () => `192.168.1.20:${port}`,
  },
]) {
  test(`forwards /api with the Host the browser sent, ${where}`, async () => {
    assert.equal(await postThroughDevServer(host()), 204);
    assert.deepEqual(received.at(-1), {
      host: host(),
      origin: `http://${host()}`,
      url: '/api/auth/refresh',
    });
  });
}

// The landing's dev server (apps/landing/astro.config.mjs) is the site's single
// entry in development: /api to the API and /app to the web app's dev server,
// each with the Host the browser sent; every other path stays the landing's.
const LANDING = fileURLToPath(new URL('../apps/landing/', import.meta.url));
/**
 * The part of Astro's programmatic dev server this test uses (Astro is the
 * landing's dependency, resolved from there).
 * @typedef {{ address: import('node:net').AddressInfo; stop(): Promise<void> }} AstroDevServer
 */
/** @type {{ dev(config: object): Promise<AstroDevServer> }} */
const astro = await import(
  pathToFileURL(createRequire(join(LANDING, 'package.json')).resolve('astro')).href
);

/** @type {{ host?: string; url?: string }[]} */
const reachedWeb = [];
const web = createHttpServer((req, res) => {
  reachedWeb.push({ host: req.headers.host, url: req.url });
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('web app');
});
/** @type {AstroDevServer} */
let landing;

before(async () => {
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  const address = web.address();
  assert.ok(address !== null && typeof address === 'object');
  // Read by astro.config.mjs when the configuration loads; the API stand-in
  // is the one above (API_PROXY_TARGET, already set).
  process.env.WEB_PROXY_TARGET = `http://127.0.0.1:${address.port}`;
  process.env.ASTRO_TELEMETRY_DISABLED = '1';
  landing = await astro.dev({
    root: LANDING,
    logLevel: 'silent',
    // An address the requests below can reach, on a free port.
    server: { host: '127.0.0.1', port: 0 },
    devToolbar: { enabled: false },
  });
});

after(async () => {
  await landing.stop();
  web.close();
});

/**
 * A request through the landing's dev server, as a browser at `host` sends it.
 * @param {string} method
 * @param {string} path
 * @param {string} host
 * @returns {Promise<{ status: number | undefined; body: string }>}
 */
function throughLanding(method, path, host) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: landing.address.port,
        method,
        path,
        headers: { Host: host, Origin: `http://${host}` },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('the landing forwards /api with the Host the browser sent', async () => {
  const host = `localhost:${String(landing.address.port)}`;
  assert.equal((await throughLanding('POST', '/api/auth/refresh', host)).status, 204);
  assert.deepEqual(received.at(-1), {
    host,
    origin: `http://${host}`,
    url: '/api/auth/refresh',
  });
});

test('the landing forwards /app and everything under it to the web app', async () => {
  const host = `localhost:${String(landing.address.port)}`;
  for (const path of ['/app', '/app/', '/app/sign-in?next=1']) {
    assert.deepEqual(await throughLanding('GET', path, host), { status: 200, body: 'web app' });
    assert.deepEqual(reachedWeb.at(-1), { host, url: path });
  }
});

test('the landing keeps its own pages, even when their names start like a proxied path', async () => {
  const host = `localhost:${String(landing.address.port)}`;
  const before = reachedWeb.length;
  const home = await throughLanding('GET', '/', host);
  assert.equal(home.status, 200);
  assert.match(home.body, /<html lang="en">/);
  assert.equal((await throughLanding('GET', '/apple-touch-icon.png', host)).status, 404);
  assert.equal((await throughLanding('GET', '/application/', host)).status, 404);
  assert.equal(reachedWeb.length, before);
});

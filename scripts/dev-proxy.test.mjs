// Tests of the development proxy in apps/web/vite.config.ts
// (`node --test scripts/dev-proxy.test.mjs`): the real Vite dev server, with
// the app's own configuration, in front of a stand-in API that records what
// reaches it. A browser that sends no Fetch Metadata (Safari before 16.4, and
// any browser on a page over plain HTTP from a non-local address: a phone on
// the LAN testing the dev server) passes the API's CSRF guard only when its
// Origin is the address the request was sent to, read from Host
// (apps/api/src/common/guards/fetch-metadata.guard.ts). So the proxy must hand
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

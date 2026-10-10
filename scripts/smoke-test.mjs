// `pnpm smoke --url <public URL> --api <API URL> [--release <commit SHA>]`:
// the smoke test after a deployment (docs/ci-cd.md#deployment), a restore
// (docs/disaster-recovery.md) or a recovery (docs/incident-response.md).
// Read-only: it signs nobody in and writes nothing, so it is safe against
// production. Either URL may be left out to check one side only. Exits 1 when
// any check fails.
//
// Through the public URL (--url), what users get:
//   GET /healthz             200: the web server serves
//   GET /                    200 HTML with the security headers: the app shell
//   GET /app-config.json     200 JSON; its release is --release when given
//   GET /api/<unknown>       404 in the API's envelope with a request id: the
//                            web server reaches the API and the API answers
//   GET /api/health/ready    404: the probes stay private
// On the API itself (--api, from inside the platform's network: the probes
// are not public):
//   GET /api/health/live     200
//   GET /api/health/ready    200; "degraded" (an optional dependency down)
//                            is reported without failing
import { parseArgs } from 'node:util';

const TIMEOUT_MS = 10_000;

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    api: { type: 'string' },
    release: { type: 'string' },
  },
});

/** @param {string | undefined} value @param {string} flag */
function baseUrl(value, flag) {
  if (value === undefined) return undefined;
  if (!/^https?:\/\/[^/?#\s]+\/?$/.test(value)) {
    console.error(`${flag} must be an origin, e.g. https://app.example.com (got "${value}")`);
    process.exit(2);
  }
  return value.replace(/\/$/, '');
}

const site = baseUrl(values.url, '--url');
const api = baseUrl(values.api, '--api');
if (site === undefined && api === undefined) {
  console.error('Usage: pnpm smoke --url <public URL> --api <API URL> [--release <commit SHA>]');
  process.exit(2);
}

let failures = 0;

/**
 * One request and its expectations; a thrown Error is a failed check.
 * @param {string} label
 * @param {string} url
 * @param {(response: Response, body: string) => string | void} check
 *   returns a note to print next to "ok"
 */
async function expect(label, url, check) {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.text();
    const note = check(response, body);
    console.log(`ok    ${label}${note ? ` (${note})` : ''}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @param {Response} response @param {number} expected */
function status(response, expected) {
  if (response.status !== expected) {
    throw new Error(`status ${response.status}, expected ${expected}`);
  }
}

/** @param {string} body @returns {Record<string, unknown>} */
function json(body) {
  try {
    const value = /** @type {unknown} */ (JSON.parse(body));
    if (typeof value === 'object' && value !== null) {
      return /** @type {Record<string, unknown>} */ (value);
    }
  } catch {
    // Reported below.
  }
  throw new Error(`not a JSON object: ${body.slice(0, 80)}`);
}

/** The `data` of an API envelope. @param {string} body */
function data(body) {
  const value = json(body).data;
  if (typeof value !== 'object' || value === null) throw new Error('no data in the envelope');
  return /** @type {Record<string, unknown>} */ (value);
}

if (site !== undefined) {
  await expect('web server health', `${site}/healthz`, (response) => {
    status(response, 200);
  });

  await expect('app shell', `${site}/`, (response, body) => {
    status(response, 200);
    if (!body.includes('<div id="root">')) throw new Error('not the app shell');
    for (const header of ['content-security-policy', 'x-content-type-options']) {
      if (!response.headers.has(header)) throw new Error(`no ${header} header`);
    }
  });

  await expect('runtime configuration', `${site}/app-config.json`, (response, body) => {
    status(response, 200);
    const config = json(body);
    if (values.release !== undefined && config.release !== values.release) {
      throw new Error(`release ${String(config.release)}, expected ${values.release}`);
    }
    return `environment ${String(config.environment)}, release ${String(config.release)}`;
  });

  await expect(
    'API through the web server',
    `${site}/api/smoke-test-unknown-route`,
    (response, body) => {
      status(response, 404);
      if (typeof json(body).message !== 'string') throw new Error('not the API error envelope');
      if (!response.headers.has('x-request-id')) throw new Error('no X-Request-Id header');
    },
  );

  await expect('probes not public', `${site}/api/health/ready`, (response) => {
    status(response, 404);
  });
}

if (api !== undefined) {
  await expect('API liveness', `${api}/api/health/live`, (response) => {
    status(response, 200);
  });

  await expect('API readiness', `${api}/api/health/ready`, (response, body) => {
    status(response, 200);
    const ready = data(body);
    if (ready.status === 'degraded') return `degraded: ${JSON.stringify(ready.checks)}`;
    if (ready.status !== 'ok') throw new Error(`status ${String(ready.status)}`);
    return undefined;
  });
}

// exitCode, not exit(): ending the process while fetch's connections are
// closing trips an assertion of libuv on Windows, and the status is lost.
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(
    site !== undefined && api !== undefined
      ? 'Smoke test passed.'
      : `Smoke test passed (${site === undefined ? 'API' : 'public URL'} only).`,
  );
}

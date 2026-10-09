# Security

What the template does, where, what it does not do, and what every new project still has to
decide. Reporting a vulnerability: [SECURITY.md](../SECURITY.md).

No configuration makes an application impenetrable. These controls close the common, well-known
attacks by default and make the rest visible: [Known limits](#known-limits) lists what stays open
on purpose, and [Per project](#per-project-requiere-configuración) what each project must decide.

## Controls by OWASP Top 10 (2021) category

| Risk                                  | Control in the template                                                                                                                                                                                                                                                                                                                                   | Where                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A01 Broken access control             | `@Auth(...roles)` on every non-public route; ownership checks in services (404 for others' records); Fetch Metadata guard on every route (CSRF); route guards in the web app                                                                                                                                                                              | `auth/auth.decorator.ts`, `users/users.service.ts`, `common/guards`, `web/src/auth/guards.tsx` |
| A02 Cryptographic failures            | argon2id (OWASP parameters); refresh tokens stored as SHA-256; HS256 pinned on signer and verifier, 64+ character secret; Secure cookies in production; `Cache-Control: no-store` on every API response; HTTPS at the edge                                                                                                                                | `auth/password.ts`, `auth/sessions.service.ts`, `auth/auth.module.ts`, `env/`                  |
| A03 Injection                         | Zod validation of every body and query; Prisma parameterized queries (ESLint forbids the `*Unsafe` raw variants); React escaping (ESLint flags `dangerouslySetInnerHTML`); strict CSP on the web server; SAST (Semgrep) on every pull request; ZAP API scan (DAST) weekly                                                                                 | `common/pipes`, `common/openapi`, `web/nginx`, `eslint.config.js`, `scripts/sast.mjs`          |
| A04 Insecure design                   | Contract review before implementation; threat questions in code review; Definition of Done security item                                                                                                                                                                                                                                                  | `openapi/README.md`, `docs/code-review.md`                                                     |
| A05 Security misconfiguration         | Validated env (boot fails on bad config; `NODE_ENV` has no default; `TRUST_PROXY` required in production); helmet headers; no Swagger UI in production; API on loopback outside production; probes not public; non-root containers without Node.js package managers                                                                                       | `env/`, `app.setup.ts`, `main.ts`, Dockerfiles, `web/nginx`                                    |
| A06 Vulnerable components             | `pnpm audit` (high+ fails) locally and in CI; image scanning (Trivy) in CI; Dependabot; seven-day release delay, trust-downgrade refusal, install-script allowlist, registry-only sources and a license policy; GitHub Actions pinned by SHA and tool images by digest                                                                                    | `pnpm-workspace.yaml`, `scripts/dependency-policy.json`, `.github/`                            |
| A07 Identification and authentication | Short access tokens in memory; rotating refresh tokens in families with reuse detection and a 90-day absolute lifetime; timing-safe sign-in; per-IP sign-in limit that a forged `X-Forwarded-For` cannot escape                                                                                                                                           | `auth/`, `web/src/auth/`                                                                       |
| A08 Software and data integrity       | Frozen lockfile installs with sha512 integrity, lockfile diffs visible in review; committed migrations only; CI gates before merge; workflows audited (zizmor) with least-privilege tokens; deploys only commits on `main`, gates re-run on the exact SHA; immutable release tags; SBOM per release; provenance and SBOM attestations on published images | `.github/workflows/`, `.github/rulesets/`, `scripts/check-dependencies.mjs`                    |
| A09 Logging and monitoring failures   | Structured logs with request ids shared by nginx and the API, automatic redaction of credentials in every log line, error report and span; 5xx logged with stack and origin; access logs without query strings or bodies; theft of a refresh token logged as a warning; optional error tracking and tracing with the same redaction                       | `common/logging/`, `observability/`, `web/nginx`, docs/observability.md                        |
| A10 Server-side request forgery       | The API makes no outbound requests; any feature that fetches a user-supplied URL needs an allowlist (REQUIERE CONFIGURACIÓN). nginx forwards its own upstream name as `Host`, never the client's                                                                                                                                                          | `web/nginx`                                                                                    |

## Authentication and tokens

- **Access token:** JWT, HS256, 15 minutes, claims `{ sub, role }` only, held **in memory** by the
  web app (`web/src/auth/session.ts`), never in `localStorage`/`sessionStorage`. Verified offline
  (signature, expiry, claims shape), with the algorithm pinned.
- **Refresh token:** 32 random bytes in an **httpOnly** cookie, `SameSite=Strict` (configurable).
  The database keeps only its SHA-256. In production the cookie is `__Host-refresh_token`: the
  prefix makes browsers accept it only `Secure`, without `Domain` and on `Path=/`, so a site on a
  sibling subdomain cannot plant one (cookie tossing, which would sign the victim in to the
  attacker's account). The price of `Path=/` is that it also travels with requests outside
  `/api/auth`, where nothing reads it. Plain HTTP (development, tests) cannot use the prefix: there
  it is `refresh_token` on `Path=/api/auth`.
- **Rotation and families** (`auth/sessions.service.ts`, the pattern of RFC 9700): every refresh
  token works once; a refresh replaces it with a successor in the same **family** (one family per
  sign-in). A token presented again more than 30 seconds after its rotation means someone else
  holds a copy: its whole family ends (the thief's copy and the user's current token), the
  incident is logged (`Refresh token reuse for user <id>`), and the user's other sign-ins (other
  devices) are untouched. Within 30 seconds it is a client race (two tabs, a retried request): that
  request alone fails and nothing is revoked. Revoked tokens stay recorded until their own expiry,
  so a replay is recognized at any point of a token's life.
- **Lifetimes:** each rotation slides the session to 30 days of inactivity; a family ends 90 days
  after its sign-in whatever the activity (`REFRESH_FAMILY_MAX_AGE_SEC`). Expired rows are swept
  hourly.
- **Sign-in** answers one message for an unknown email and a wrong password, with equal timing (a
  dummy hash); 10 attempts per minute per IP. A browser that signs in while it still holds a
  refresh cookie ends that cookie's family first: one family per browser.
- **Logout** ends the family of the presented cookie, even if that token was already rotated (a tab
  that missed a rotation still signs the session out), then clears both cookies. When the database
  cannot be reached it answers 500 and keeps them: the family is still live, and the sign-in page's
  retry needs the cookie to end it.
- **Concurrent changes:** every change to a user's sessions takes that user's row lock first, so
  sign-ins, rotations, logouts and revocations never interleave. A sign-in whose password hash
  changed between the check and the session (a password change with `revokeAll` in between) is
  refused, so it cannot outlive the revocation.
- **Two refresh cookies** (one planted for a parent domain next to ours, where the prefix is not
  available) are never guessed between: refresh answers `401 Ambiguous session cookies` without
  clearing anything (clearing would delete only ours and hand the next refresh to the planted one);
  sign-in and logout ignore them.
- **Refresh failures:** only a 401 clears the cookies. Two refresh cookies keep them (above), a
  lost race keeps them (the winner's cookie is already in the jar), and so does a server error: a
  database failover does not sign anyone out.
- **`has_session` cookie:** readable, no secret; tells the app whether a boot refresh is worth
  trying.
- **Not included (REQUIERE CONFIGURACIÓN per product):** sign-up, email verification, password
  reset, MFA, SSO, account lockout per user, session listing. When adding passwords set by users,
  follow OWASP ASVS / NIST SP 800-63B: minimum 12 to 15 characters, no composition rules, check
  against breached-password lists, keep `PASSWORD_MAX_LENGTH`.

### Web client

- **401 handling** (`web/src/auth/middleware.ts`): a 401 to a request that carried a token
  triggers one refresh (shared by every concurrent caller) and one replay; a second 401 signs out.
  A request that went out without a token is left alone; when another request already refreshed,
  the replay uses that token instead of rotating again; and a request is never replayed for
  another user than the one who sent it.
- **One refresh at a time across tabs** (`web/src/auth/session.ts`): tabs share the cookie and
  every refresh rotates it, so they take turns through a Web Lock and none presents a token another
  has just rotated. Without Web Locks (or when the browser refuses the lock), one retry covers a
  race between two tabs.
- **Sign-out** is immediate in the tab and in the other open tabs (`BroadcastChannel`), including
  one that was picking up the session at that moment (its refresh never lands). The
  `has_session` hint is dropped first, so even a page closed at that instant leaves nothing the next
  visit would restore; the logout request leaves at once, with `keepalive` so closing the page
  does not cancel it, without waiting for a refresh in flight (any token of the family ends the
  whole family). If the server cannot be reached, the sign-in page says so and offers a retry.
- **Ordering:** a sign-in waits for a logout or a refresh still on its way, which would otherwise
  clear or replace the cookie it sets; a refresh that lands after a sign-in or a sign-out never
  overwrites it.
- After a sign-out the next user starts at home, not on the page the previous one left.

## Secret rotation

`JWT_ACCESS_SECRET` signs access tokens only; refresh sessions do not depend on it, so rotating it
never signs anyone out: a refused access token is renewed by the next refresh.

- **Leaked secret:** deploy a new `JWT_ACCESS_SECRET` (`openssl rand -hex 32`) without
  `JWT_ACCESS_SECRET_PREVIOUS`. Every token signed with the old one, forged or not, is refused at
  once.
- **Planned rotation, one instance:** deploy `JWT_ACCESS_SECRET=<new>` and
  `JWT_ACCESS_SECRET_PREVIOUS=<old>`; after 15 minutes (`ACCESS_TOKEN_TTL_SEC`) remove the previous
  value and deploy again.
- **Planned rotation, several instances:** during a rolling deployment old and new instances run
  together, so first deploy `JWT_ACCESS_SECRET_PREVIOUS=<new>` (every instance accepts the new
  secret, none signs with it yet), then swap the two values, then remove the previous one after 15
  minutes.

Other secrets (`DATABASE_URL` credentials, registry tokens) rotate the same way as anywhere: create
the new value, deploy, verify, then revoke the old one.

## Authorization

Two layers, both required:

1. **Role (RBAC):** `@Auth('admin')` on the controller, or `@RequireRoles('admin')` on one handler
   of an `@Auth()` controller. Roles live in `common/types/request-user.ts` and the Prisma `Role`
   enum (a spec keeps them equal).
2. **Ownership (BOLA/IDOR):** the service decides whether this caller may touch this record, in the
   query itself (`UsersService.findVisible`). Records the caller may not see answer **404**, exactly
   like missing ones, so ids cannot be probed. The rules (writes, lists, nested and shared records,
   admin access) and the access-matrix test every such route gets:
   [authorization.md](authorization.md).

Role changes apply at the next refresh. `SessionsService.revokeAll(userId)` ends every refresh
session at once, but an access token already issued stays valid until it expires (at most 15
minutes): access tokens are verified offline, without a database lookup. If that window is too
long for a project, shorten `ACCESS_TOKEN_TTL_SEC` or have `JwtAuthGuard` check a per-user token
version (OPCIONAL, one query per request).

### Route protection

`RequireAuth`, `RequireRole` and `GuestOnly` are layout routes. They decide what to **show**; the
API decides what is **allowed**. Never rely on a hidden link or a client guard alone.

## CSRF, CORS, XSS

- **CSRF:** `FetchMetadataGuard` runs first on **every** route (a global guard, before the rate
  limiter): a request whose `Sec-Fetch-Site` says another origin made the browser send it
  (`cross-site`, and `same-site`: a sibling subdomain) is refused with 403 unless its `Origin` is in
  `CORS_ORIGINS`. Requests without the header pass: older browsers still apply SameSite, and
  non-browser clients carry no victim's cookies. Bearer-token routes cannot be forged anyway
  (browsers never attach the header), and the API accepts JSON bodies only
  (`common/http/json-only.middleware.ts`, 415 otherwise): HTML forms, the one kind of body another
  site can send without a CORS preflight, never reach a handler.
- **CORS:** off by default. The web app reaches the API on its own origin (Vite proxy in
  development, the web image's nginx in production). Set `CORS_ORIGINS` only for a client on another
  origin, sibling subdomains included; for another _site_, also set `AUTH_COOKIE_SAMESITE=none`
  (production only).
- **XSS:** React escapes output; never use `dangerouslySetInnerHTML` without a sanitizer (OPCIONAL:
  DOMPurify). The web image sends a strict CSP (`default-src 'self'`, no inline scripts, no
  framing); widen it per directive, in review, when a feature needs it.

## Security headers and caching

API: helmet defaults (CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
CORP/COOP, no `X-Powered-By`) and `Cache-Control: no-store` on every response (they carry tokens
and personal data). Web image: CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
`Referrer-Policy`, `Permissions-Policy`, COOP (`apps/web/nginx/security-headers.conf`); hashed
assets cached for a year, never an error response. The CSP's `connect-src` gains exactly one origin
when browser error tracking is configured: Sentry's ingest host, derived from `WEB_SENTRY_DSN` by
the web server (nothing else can widen it at runtime).

## HTTPS

TLS terminates at the edge (load balancer, ingress, CDN); REQUIERE CONFIGURACIÓN per provider. Set
HSTS there (`max-age` ≥ 1 year once HTTPS is permanent) and redirect HTTP to HTTPS.

**Client IP behind proxies.** Rate limits and logs need the real client address, which proxies pass
in `X-Forwarded-For`, a header any client can also send. The API believes it only across the hops
`TRUST_PROXY` names, and production refuses to boot without the setting:

- Behind the web image: `TRUST_PROXY=1`. nginx **replaces** `X-Forwarded-For` with the address that
  connected to it, so whatever a client wrote there is dropped.
- With a load balancer in front of nginx: keep `TRUST_PROXY=1` and let nginx's realip module put
  the client address in `$remote_addr` (`set_real_ip_from` with the balancer's addresses and
  `real_ip_header X-Forwarded-For` in `apps/web/nginx/default.conf.template`), instead of trusting
  more hops.
- The API must be reachable only through that proxy (a private network). A client that reaches it
  directly can choose its own `X-Forwarded-For`.

**Host header.** nginx sends the API its own upstream name as `Host`, never the one the client
wrote, and blanks `X-Forwarded-Host`: nothing behind the proxy can build a link from an
attacker-chosen host (password-reset or redirect poisoning). A feature that needs the public URL
reads it from configuration (an env variable), never from the request.

**Upstream address.** nginx looks `API_UPSTREAM` up again every 10 seconds, through the DNS of the
container platform (`/etc/resolv.conf`: Docker's or the cluster's), instead of once at start. After
a redeployment the API's previous address can belong to another container; a proxy that kept it
would hand that container the API's traffic, cookies and tokens included.

Outside production the API listens on 127.0.0.1 only (`HOST`), so a development server with public
seed accounts never reaches the network; in production it listens on every interface, IPv4 and
IPv6.

## Rate limiting

`@nestjs/throttler`, per client IP and per route: `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_SEC`
(default 100/60 s), sign-in 10/min, refresh 30/min, health probes exempt; `429` with `Retry-After`.

The counters live in a **store** chosen by `RATE_LIMIT_STORE`
(`infrastructure/rate-limit/rate-limit.store.ts`); the guard, the limits and the routes are the same
with either:

| Store              | When                                            | Behavior                                                                                                                                    |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory` (default) | one instance                                    | the throttler's in-memory store, as the template always had                                                                                 |
| `redis`            | several instances (OPTIONAL, needs `REDIS_URL`) | shared counters: a client cannot multiply its allowance by the number of instances; same algorithm, atomically in a Lua script, server time |

While Redis is unreachable the Redis store does **not fail open**: each instance falls back to its
own in-memory counters (limits become per instance), logs the switch once, counts it
(`app.degraded.operations`) and goes back to Redis as soon as it answers. Add per-account limits
for sign-in if credential stuffing is a concern (attempts spread over many addresses).

## Input and output validation

Every body and query passes a Zod schema (`@ZodBody`, `@ZodQuery`); path ids pass `ParseUUIDPipe`.
Responses select explicit columns (`USER_SELECT`) and match the documented schema. Bodies are
capped at 100 kB.

## SQL injection

Prisma parameterizes every query. Raw SQL only through tagged templates (`$queryRaw\`...${value}\``),
never the `*Unsafe`variants with interpolated input (the one use,`$executeRawUnsafe` in the test reset
helper, interpolates table names read from the database catalog).

## Secrets

- Never in git: `.gitignore` excludes `.env*`, `*.env` and `.envrc` except examples; the pre-commit
  hook refuses those files when staged and scans every staged file with secretlint, files forced
  past `.gitignore` included; `pnpm secrets:scan` (in CI too) scans every file git tracks or would
  add, and CI scans the whole history (gitleaks).
- Never in an image: the Docker build context is an allowlist (`.dockerignore`): the workspace
  manifests, the lockfile and `apps/`, minus env files, keys and certificates, logs and build
  output. Anything else placed under `apps/` (a database dump, say) would still reach the build
  stage and its cache, so keep such files out of the repository tree; the final images get only
  what their Dockerfiles copy.
- Never in logs: the access logs (API and nginx) have no cookies, authorization or other headers
  (nginx records the user agent), no bodies and no query strings; env validation errors name the
  variable, never the value; the 5xx log has the stack, not the request; and every line is
  redacted automatically ([Logging](#logging)). They do record the client IP and the user id (what
  an investigation needs): personal data in some jurisdictions, so log retention and access follow
  the project's data policy.
- Never in the bundle: `VITE_*` variables are public (apps/web/.env.example).
- In production: the platform's secret store or the GitHub environment secrets, one value per
  environment (docs/environment.md#secrets). Rotation: [Secret rotation](#secret-rotation).
- A leaked secret is rotated first, then removed from history if needed; removal alone is not enough.

## Logging

Logs, error reports and spans leave the process; credentials must not. Three layers, in order:

1. **Nothing sensitive is logged on purpose:** the access log records method, path (no query
   string), status, duration, IP and user id; error lines record the stack; no code logs headers,
   cookies, bodies, tokens or env values (review rule, ENGINEERING_STANDARDS.md).
2. **Automatic redaction** (`observability/redact.ts`) of everything the logger prints, whatever a
   developer passes to it: values under sensitive keys (`password`, `passwordHash`, `token`,
   `accessToken`, `refreshToken`, `authorization`, `cookie`, `set-cookie`, `apiKey`, `secret`,
   `privateKey`, `credential`, `signature`, `sessionId`, `dsn`, in any letter case and at any depth),
   and credentials written inline in strings, error messages and stack traces: user:password in
   URLs (database, Redis), `Bearer`/`Basic` values, JWTs, `token=`/`password=`/`apiKey=` pairs in
   query strings, cookies, JSON (JSON serialized inside a JSON string too) and pretty-printed
   objects (Prisma's error messages), PEM private keys, and well-known provider token formats. The
   logger, the error tracker's `beforeSend` and the span processor all use it. The patterns are linear-time (a hostile multi-megabyte string
   cannot stall the logger) and inputs are never mutated.
3. **Specs** prove it: `redact.spec.ts` (each pattern, objects, errors, cycles, a performance
   bound), `logger.spec.ts` (JSON and text output never contain the planted secrets).

Redaction is a safety net, not a license: it recognizes credential shapes, not every piece of
personal data. Log ids, not emails, names or free text.

## Error tracking data

When `SENTRY_DSN` / `WEB_SENTRY_DSN` are set (OPTIONAL), reports go to a third party
(docs/observability.md#error-tracking). What they may contain is decided in code:

- **Explicit context only.** The API's client has no breadcrumbs and no request data; each report
  carries the error, its stack and the fields the error filter passes: request id, method, route
  pattern, status, origin, an opaque user id, environment and release. The browser SDK sends the
  page path (no query string) and its own error context.
- **Collection off by category:** Sentry's `dataCollection` defaults collect cookies, headers,
  bodies, query strings, user details and local variables; both apps switch each category off
  (`DATA_COLLECTION`), and the API types its options so a renamed option fails the build instead
  of silently re-enabling a default.
- **Scrubbed again before sending** (`scrubEvent`): request reduced to method and URL without query,
  user to its id, breadcrumbs dropped (API) or stripped of URLs' query strings and secret-looking
  fields (browser, console breadcrumbs dropped), every message and field through the log redaction.
- **Production DSNs must be https** (boot check); a malformed DSN fails the boot instead of turning
  error tracking off silently. Use separate Sentry projects for API and web, restrict who can read
  them, and set the data retention the project's policy allows.
- Telemetry follows the same rules: spans carry statements with placeholders, never values; URL
  attributes lose their query string and credentials; string attributes are redacted
  (`RedactingSpanProcessor`). Provider credentials (`OTEL_EXPORTER_OTLP_HEADERS`) are read by the
  exporters from the environment, never by application code.

## Redis

OPTIONAL infrastructure (docs/architecture.md#redis). Secure defaults, development and production:

| Concern             | Development (`docker compose --profile redis`)                                                                       | Production (REQUIRES CONFIGURATION)                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where               | a container on this machine                                                                                          | a managed or private Redis (ElastiCache, Memorystore, Azure Cache, Upstash...) on the private network only, never a public endpoint              |
| Network             | published on 127.0.0.1 only                                                                                          | reachable from the API's network only (security groups, private endpoints)                                                                       |
| Authentication      | password required (`REDIS_PASSWORD` in the root `.env`, never committed); the container refuses to start without one | an ACL user limited to the key prefix and the commands the adapters run (list in docs/architecture.md#redis), its password from the secret store |
| Encryption          | none (loopback)                                                                                                      | TLS: `rediss://` (the API warns at boot about `redis://` in production)                                                                          |
| Credentials in logs | never: the URL is logged as host:port, errors are redacted                                                           | same                                                                                                                                             |
| Persistence         | AOF every second, a volume                                                                                           | per use: cache and rate limits can lose data; locks and idempotency claims should survive a restart (AOF or the provider's persistence)          |
| Memory              | 256 MB, evicts only keys with a TTL (`volatile-lru`)                                                                 | sized to the workload, with the same policy: every key the template writes has a TTL, so keys without one (a future job queue) are never evicted |
| Process             | runs as the `redis` user; password passed through a file, not the command line                                       | the provider's hardening                                                                                                                         |

The application treats Redis as untrusted for correctness: losing it degrades features but never
authorizes a request, and no session or authorization data lives there.

## Dependency vulnerabilities

`pnpm security` = `pnpm audit --audit-level=high` + `pnpm deps:check` + the repository secret scan. High and critical
advisories fail the gate. Fix order: update the direct dependency; if the vulnerable package is
pinned by a dependency, add a scoped override in `pnpm-workspace.yaml` naming the advisory (two are
there now, for packages pinned by the Prisma CLI); if neither is possible, document an exception
with the advisory, why it is not exploitable here, and a review date, in the pull request and here.

**Urgent fix younger than the release delay:** exempt only the fixed version, in
`minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, with the date the exemption expires and the
advisory:

```yaml
minimumReleaseAgeExclude:
  - 'vite@8.3.3' # expires 2026-10-16: GHSA-xxxx-xxxx-xxxx
```

`pnpm deps:check` enforces the form: an exact version (`name@1.2.3`, or `name@1.2.3 || 1.2.4`),
never a bare name, a range or a wildcard, which would let every future release skip the delay too;
an expiry date at most one delay (seven days) ahead, since the version is old enough by then; and a
plain block list, since an entry written inline carries no date. It fails once the date has passed,
and on any exemption pnpm applies that the list does not hold (a global pnpm configuration, a
`PNPM_CONFIG_*` variable). Remove the entry when it expires, or earlier with the next update.

The other supply-chain controls: [Dependency policy](#dependency-policy) and
[Dependency maintenance](#dependency-maintenance).

## Dependency policy

Enforced on every install (pnpm settings in `pnpm-workspace.yaml`) and by `pnpm deps:check` (part
of `pnpm security`, so of `pnpm verify` and CI), with the policy in
`scripts/dependency-policy.json`:

| Control                     | What it stops                                                                                                                         | Where                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Frozen lockfile             | Installing anything the reviewed `pnpm-lock.yaml` does not list, with its sha512 integrity                                            | `.github/actions/setup` (`--frozen-lockfile`)                                |
| Registry sources only       | A dependency from a git repository, a tarball URL or a folder (no registry integrity, no release delay)                               | `blockExoticSubdeps` (transitive), `deps:check` (direct)                     |
| Release delay (seven days)  | A hijacked release, usually detected and unpublished within days; exemptions are exact versions that expire                           | `minimumReleaseAge`, Dependabot `cooldown`, `deps:check` (exemptions)        |
| Trust downgrade refused     | A new version published with weaker evidence than earlier ones (provenance lost: a stolen token)                                      | `trustPolicy: no-downgrade`                                                  |
| Install scripts allowlisted | Code running at install time without a reviewed decision                                                                              | `allowBuilds`                                                                |
| License policy              | A license the product cannot ship: production dependencies need a permissive license, tools may also use weak copyleft; unknown fails | `deps:check`, `scripts/dependency-policy.json`                               |
| Known vulnerabilities       | High and critical advisories                                                                                                          | `pnpm audit`, Trivy on the images                                            |
| Weakened settings           | Lowering the delay, dropping the trust policy or the block on exotic sources; removing the Dependabot cooldown                        | `deps:check` (floors in `scripts/dependency-policy.json`); zizmor (cooldown) |

**License expressions** are read as SPDX defines them: `WITH` binds tighter than `AND`, `AND`
tighter than `OR`, parentheses group. One passes when some way to comply with it (every license of
an `AND`, one branch of an `OR`) uses allowed licenses only: `(MIT OR GPL-2.0) AND GPL-3.0` fails.
An expression that does not parse fails, like an unknown license.

**Adding a dependency** ([how-to](how-to.md#add-a-dependency)): maintained (recent releases, more
than one maintainer for anything security-relevant), an allowed license, no install script unless
it builds a native binary, no lighter alternative already in the tree, and named in the pull
request with the reason. `pnpm-lock.yaml` diffs are shown in review, not collapsed.

**Exceptions** (a license or a source) go in `scripts/dependency-policy.json` with the reason; the
file is owned by the maintainers (`CODEOWNERS`). A dependency nobody imports any more is removed in
the pull request that stops using it.

## Dependency maintenance

**Dependabot** opens the update pull requests (`.github/dependabot.yml`): weekly, grouped
(production minor/patch, development minor/patch, actions, tool images), each with the full CI.
It covers npm, GitHub Actions (SHA pins and their version comments), the Dockerfiles' base images,
Docker Compose and the tool images (`.github/tool-images/Dockerfile`, tag and digest). Version
updates wait the same seven days as pnpm; **security updates** (Dependabot alerts) are not delayed.
Majors arrive one per pull request, with their release notes to read. A person still approves every
update: once approved and green, a patch or minor update merges itself
([ci-cd.md](ci-cd.md#dependency-updates)); majors and workflow updates are merged by hand.

Chosen over Renovate: it is built into GitHub (no third-party app with write access to the
repository, no token to host), it already understands every ecosystem here, and its alerts and
security updates share one view with the advisories. Renovate does more (any file through custom
managers, automerge rules, a dependency dashboard); the template covers its main gap, pins inside
workflow commands, with the tool-images Dockerfile instead. A project that needs more can switch
(OPCIONAL); the policy above stays the same.

## Container images

- The images run as a non-root user. The API and migration images contain no Node.js package
  manager: npm, corepack and yarn are removed from the Node.js base (unused attack surface with
  advisories of their own); the operating system's package manager stays (apt in the Debian base,
  apk in the Alpine one; a distroless base would remove it too, OPCIONAL). The runtime image holds
  the production dependencies and the compiled API; the migration image the production
  dependencies (the Prisma CLI is one), the CLI's schema engine and the migrations, with no source
  code and no development tools. Every image applies the operating system fixes published after
  its base was built (`apt-get upgrade` in the API and migration images, `apk upgrade` in the web
  image), so a fixed advisory in the base does not wait for the next base release.
- CI scans every image with Trivy (`docker-images.yml`): a HIGH or CRITICAL advisory **with a
  published fix** fails the build. Fix it by rebuilding (newer base patches), updating the base image
  (Dependabot proposes it weekly) or updating the dependency; unfixed advisories are reported by the
  tool but cannot be acted on.
- Base images are pinned by tag and digest in the Dockerfiles: a tag moved on the registry changes
  nothing until Dependabot proposes the new digest (weekly, with the base's patches) in a pull
  request that runs the full CI. Every build still applies the operating system fixes published
  since (above). They come from registries without Docker Hub's anonymous pull limit, which CI
  runners hit: Node.js from ECR Public's mirror of Docker's official images
  (`public.ecr.aws/docker/library/node`), nginx from NGINX's own registry
  (`ghcr.io/nginx/nginx-unprivileged`), the same images and digests as on Docker Hub.
- Locally, after `docker compose --profile stack build`:
  `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$(node scripts/tool-image.mjs trivy)" image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed <image>`.

## Repository and delivery

- **Rulesets** (`.github/rulesets/`): `main` takes changes through reviewed pull requests only
  (linear history, stale approvals dismissed, the last push approved by someone else, code owners'
  approval once `CODEOWNERS` is filled in), and the **CI passed** and **Conventions** checks count
  only when GitHub Actions reports them (`integration_id`), not a status anyone with a token can
  post. Release tags
  `v*` cannot be moved or deleted.
- **CODEOWNERS** lists the security-sensitive paths, the gates included (`.github/`, hooks,
  scripts): owning the checks is what keeps them from being edited away in the same pull request.
- **Deploy** (`deploy.yml`) resolves the requested ref to a commit, refuses one that is not on
  `main`, re-runs every gate on that exact commit and releases that commit only. The workflow
  file's own checks can be edited on a branch, so the environments must also allow deployments
  from `main` only (docs/ci-cd.md#repository-settings-requiere-configuración).

## Static analysis

| Layer                          | Runs                                          | Blocks | Catches                                                                                                                     |
| ------------------------------ | --------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| ESLint `strictTypeChecked`     | `pnpm verify`, pre-commit, CI                 | yes    | unsafe `any` flows, floating promises; `eval`/`new Function`, raw-SQL `*Unsafe` calls, `dangerouslySetInnerHTML`            |
| Semgrep (`pnpm sast`)          | CI on every pull request; locally with Docker | yes    | OWASP Top 10 patterns in TypeScript, Express, React and JWT code; hard-coded secrets; Dockerfile and nginx misconfiguration |
| zizmor (`pnpm lint:workflows`) | CI on every pull request; locally with Docker | yes    | GitHub Actions: excessive permissions, template injection, unpinned or impostor actions, persisted credentials              |
| CodeQL                         | CI, opt-in (`ENABLE_CODEQL=true`)             | no     | Cross-file data flow (taint) from requests to dangerous sinks; results in the Security tab                                  |

**Semgrep** runs Semgrep's curated rulesets (`scripts/sast.mjs`) on everything `.semgrepignore`
does not exclude, tests included: the files git tracks plus the new ones it does not ignore, copied
to a temporary directory first, so a local run never walks `node_modules` or build output through
Docker's file sharing. Symbolic links are not followed. Any finding fails: on this code base the rulesets report nothing,
so a finding is worth a look. A false positive is suppressed on its line with the reason, which
review sees: `// nosemgrep: <rule-id> -- why it is safe`. The rulesets are fetched from the
Semgrep registry at each run, so a new rule can flag existing code; fix or suppress it in its own
pull request.

**CodeQL** (OPCIONAL) adds the cross-file analysis Semgrep's open-source engine does not do. It
needs a public repository or GitHub Advanced Security: enable it with the repository variable
`ENABLE_CODEQL=true`. Dependency review on pull requests works the same way
(`ENABLE_DEPENDENCY_REVIEW=true`).

## Dynamic analysis

`.github/workflows/dast.yml` runs **OWASP ZAP** against the running application (ADVISORY: not a
required check):

- **Weekly and on demand, against a throwaway stack** built from the production images on the CI
  runner: the baseline scan (passive: headers, cookies, disclosures) on the web app, and the API
  scan (active: injection, XSS, path traversal) on every operation of `openapi/openapi.json`.
- **On demand against staging** (`DAST_STAGING_URL`, REQUIERE CONFIGURACIÓN): the baseline scan
  only, which sends nothing a normal visitor would not. Never run active scans against a shared
  environment without its owners' agreement.

Rule levels live in `.zap/rules.tsv`: FAIL for what the template guarantees (security headers, no
version or error disclosure, no injection), WARN for what depends on the deployment (HSTS at the
edge), IGNORE for informational noise, each with its reason. Reports are kept 30 days as the
`zap-reports-*` artifact. The scans are unauthenticated: they reach what an anonymous visitor
reaches; authenticated scanning is per project (OPCIONAL: a ZAP context with a test account).

## Artifact integrity

| What                                    | Status                              | How                                                                                                                       |
| --------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Lockfile integrity                      | Obligatorio                         | sha512 per package, frozen installs, registry sources only ([Dependency policy](#dependency-policy))                      |
| SBOM of each release                    | Obligatorio                         | CycloneDX of the production dependencies, attached to the GitHub release by `release.yml` (`pnpm sbom:generate` locally)  |
| SBOM and provenance of published images | Obligatorio once images are pushed  | BuildKit attestations (`sbom: true`, `provenance: mode=max`) on the push in `docker-images.yml`, stored next to the image |
| Scanned image = shipped image           | Obligatorio                         | The push reuses the scanned build's cache (same layers); deployments reference the digest, never a mutable tag            |
| Signed attestations (Sigstore)          | OPCIONAL                            | `actions/attest-build-provenance` step ready in `docker-images.yml`; needs a public repository or GitHub Enterprise Cloud |
| Verification before deploying           | OPCIONAL (with signed attestations) | `gh attestation verify oci://<image>@<digest> --repo <owner>/<repo>` in the release job of `deploy.yml`                   |

Signing with a separate tool (cosign with keys) is not included: GitHub attestations are already
Sigstore signatures, verifiable without managing keys. To see what a pushed image carries:
`docker buildx imagetools inspect <image>@<digest> --format '{{ json .Provenance }}'` (or
`.SBOM`).

## Known limits

Accepted on purpose, each with its way out:

- **Access tokens outlive a revocation** by up to 15 minutes (offline verification). Way out:
  shorter TTL or a per-user token version check (see [Authorization](#authorization)).
- **Rate limits are per IP**, and per instance with the default memory store (and while a Redis
  store is unreachable). A distributed credential-stuffing attack (many addresses) is not
  stopped. Way out: `RATE_LIMIT_STORE=redis`, per-account limits, CAPTCHA or MFA.
- **Redaction recognizes credential shapes, not all personal data**: an email or a name written
  into a log message stays readable. Way out: log ids (review rule).
- **No MFA, no account lockout, no breached-password check**: the account lifecycle is product
  work (see Authentication).
- **A refresh response lost on the network** (the server rotated the token, the browser kept the
  old cookie) looks like theft once 30 seconds have passed: the family ends and the user signs in
  again. That is the price of reuse detection (RFC 9700 accepts it); raise
  `REFRESH_REUSE_LEEWAY_SEC` only with a reason.
- **Old browsers** without `BroadcastChannel` keep a signed-out tab's access token until it expires
  (15 minutes), and without Web Locks three or more tabs refreshing at the same moment can sign one
  of them out locally (it signs in again; the session itself is fine). The server session is
  ended either way.
- **nginx error log lines** (upstream failures) include the full request line, query string
  included; the access logs do not.
- **DAST is advisory and unauthenticated, and there is no penetration test**: the gates find
  known patterns, not logic flaws (an authorization rule that is wrong but consistent passes
  them). Way out: authenticated ZAP scans (OPCIONAL), and an external test before handling
  sensitive data.
- **Semgrep rules are fetched at each run** from its registry: CI needs it reachable, and a new
  rule can flag existing code (see [Static analysis](#static-analysis)).
- **No WAF or DDoS protection**: the edge's job (REQUIERE CONFIGURACIÓN).
- **Error tracking, tracing and alerting are prepared, not configured**: without a Sentry project,
  an OTLP backend and alert rules, failures are only in the logs (docs/observability.md).

## Per project (REQUIERE CONFIGURACIÓN)

- [ ] `SECURITY.md`: a real private contact, and GitHub private vulnerability reporting enabled.
- [ ] TLS and HSTS at the edge; `TRUST_PROXY` (and nginx realip) for the real topology.
- [ ] `CORS_ORIGINS` / `AUTH_COOKIE_SAMESITE` if the app and the API live on different origins.
- [ ] `RATE_LIMIT_STORE=redis` (with a private, authenticated, TLS Redis) if more than one API
      instance runs.
- [ ] Error tracking (Sentry projects for API and web), its access and retention; tracing backend
      and its credentials in `OTEL_EXPORTER_OTLP_HEADERS`.
- [ ] Production secrets per environment; who can read them; rotation.
- [ ] The account lifecycle the product needs (sign-up, reset, MFA, deletion).
- [ ] Data classification: which fields are personal data, retention, backups, encryption at rest
      (backups and restores: docs/disaster-recovery.md).
- [ ] CodeQL / dependency review / secret push protection / signed attestations, where the GitHub
      plan allows.
- [ ] `DAST_STAGING_URL` once staging exists; authenticated scans if the product needs them.
- [ ] The release job of `deploy.yml` deploys images by digest (and verifies their attestations
      when enabled).
- [ ] The rulesets in `.github/rulesets/`, `CODEOWNERS` filled in, and environments that deploy
      from `main` only.
- [ ] Alerts on the signals the API already logs: `Refresh token reuse for user ...` (a stolen
      refresh token), bursts of 401 and 429 on `/api/auth/sign-in`, any `fatal` line, 5xx rate.
- [ ] Log retention and access (logs contain client IPs and user ids).

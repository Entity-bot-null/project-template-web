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
| A10 Server-side request forgery       | The API makes no outbound requests of its own; integrations use `createExternalHttpClient`, which keeps every path under the configured base URL (values encoded as segments). Any feature that fetches a user-supplied URL needs an allowlist (REQUIERE CONFIGURACIÓN). nginx forwards its own upstream name as `Host`, never the client's               | `common/http/external-http.ts`, `web/nginx`                                                    |

## Authentication and tokens

- **Access token:** JWT, HS256, 15 minutes, claims `{ sub, role, sv }` only, held **in memory** by
  the web app (`web/src/auth/session.ts`), never in `localStorage`/`sessionStorage`. Verified
  offline (signature, expiry, claims shape), with the algorithm pinned, then `sv` against the
  account's `security_version` (one primary-key lookup per request): a password change or reset
  increments it, so every access token issued before is refused at once, not when it expires
  (ADR [0004](adr/0004-security-version-in-access-tokens.md)).
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
  sign-ins, rotations, logouts and revocations never interleave. Those transactions run in READ
  COMMITTED whatever the database's default, so what they read after the lock is what the one they
  waited for committed. A sign-in whose password hash changed between the check and the session (a
  password change with `revokeAll` in between) is refused, so it cannot outlive the revocation.
  Revoking sessions by hand takes the same lock
  ([incident-response.md](incident-response.md#11-authentication-or-security-attack)): a plain
  `UPDATE` misses the token a refresh in flight commits after it.
- **Two refresh cookies** (one planted for a parent domain next to ours, where the prefix is not
  available) are never guessed between: refresh answers `401 Ambiguous session cookies` without
  clearing anything (clearing would delete only ours and hand the next refresh to the planted one);
  sign-in and logout ignore them.
- **Refresh failures:** only a 401 clears the cookies. Two refresh cookies keep them (above), a
  lost race keeps them (the winner's cookie is already in the jar), and so does a server error: a
  database failover does not sign anyone out.
- **`has_session` cookie:** readable, no secret; tells the app whether a boot refresh is worth
  trying.
- **Not included (REQUIERE CONFIGURACIÓN per product):** MFA, SSO, account lockout per user,
  session listing, account deletion, changing a user's role from the web app (an operator's job).

### Passwords

The policy of every password a person sets (`auth/password-policy.ts`; `user:create`, password
reset and change), following NIST SP 800-63B-4 and the password requirements of OWASP ASVS 5.0
(chapter V6). The template is designed against them; it is not certified, and a project that
needs a compliance claim verifies it itself.

- **Length:** 15 to 200 characters, counted as code points (an emoji is one), never truncated. A request
  carries at most 400 UTF-16 units of password (200 characters outside the basic plane): a
  longer field is refused before any hashing. No composition
  rules (no "one digit, one symbol"), no periodic expiry; spaces and any Unicode are allowed.
- **Normalized** to NFKC before hashing and comparing, so the same passphrase typed on another
  keyboard or device matches. Hashes made before normalization still verify (the raw form is
  tried when it differs), so no existing password stops working.
- **Refused:** the 16,050 passwords of 15 characters or more that are most used (SecLists, MIT,
  checked locally: a password never leaves the API, `scripts/build-common-passwords.mjs` pins the
  source by commit and SHA-256); repeated characters, sequences (`abcdef...`) and repeated blocks;
  the account's email address, its local part or a word of the name (4 characters or more). The
  web app checks the same rules for quick feedback, except the list, which only the API holds.
- **Argon2id** (19 MiB, 2 passes, parallelism 1: OWASP's minimum configuration), unchanged. Sign-in hashes once whether the
  account exists or not (a dummy hash), so timing does not reveal accounts.
- **Show/hide:** every password field has a button to show what was typed (a real button,
  keyboard-reachable, `aria-pressed`), so a long passphrase can be checked before submitting.

### Password recovery and change

- **Asking for a link** (`POST /api/auth/password-resets`, `auth/password-reset.service.ts`):
  answers 204 at once, the same for any address, before looking it up; the lookup and the queueing
  run after the answer, so neither the body, the status nor the timing tells whether an account
  exists. Limits: 5 requests per 15 minutes per IP, and per address one message a minute and
  `MAIL_DAILY_LIMIT_PER_ADDRESS` a day (shared by every instance, [Email](#email)); an address
  differing only in letter case or spaces is the same address. 503 when email is off, and
  `GET /api/auth/capabilities` tells the web app not to offer it.
- **The token** (`auth/account-tokens.ts`): 256 random bits, minted when the message is sent; the
  database keeps only its SHA-256, with its purpose, account, the address it was sent to and the
  account's `security_version`. Valid for 30 minutes and once; a new link replaces the earlier
  unused ones; a credential change ends every outstanding one. Expired and used tokens are swept
  after a day.
- **The link** is `APP_ORIGIN` + `APP_BASE_PATH` + `/reset-password#token=...`
  (`https://app.example.com/app/reset-password#token=...`, never built from a request's Host). The
  token travels after `#`, which browsers never send to a server or in a `Referer`; the page reads
  it, removes it from the address bar and the history at once (`replace`), keeps it in memory only
  (never browser storage) and drops it once used. Opening the link changes nothing: only the
  form's submit spends it, so a mail scanner or a preview that fetches it does no harm. The web
  server sends `Referrer-Policy: no-referrer` and a CSP without third parties on every page.
- **Using it** (`POST /api/auth/password-resets/confirm`): the new password is checked first (a
  refused one keeps the link working); then one transaction, under the account's row lock, locks
  the token row (`FOR UPDATE`), requires it unused, unexpired, for the same account, address and
  `security_version`, marks it used, replaces the hash, increments `security_version`, ends every
  refresh session and other reset link, and queues a notice to the owner. Two simultaneous uses:
  one 204, the other 404. Any failure rolls all of it back. An unusable link answers one 404
  ("invalid or expired"), whatever the reason.
- **Changing it while signed in** (`POST /api/account/password`, the Account page): requires the
  current password (403 otherwise, 5 attempts per 15 minutes per IP), applies the same policy, and
  in one transaction under the row lock refuses a change if the password changed meanwhile (409),
  increments `security_version`, ends every session and reset link, and queues the notice. The
  browser that asked carries on in a new session the answer brings (new cookie); every other
  device is signed out at once.
- **The notice** ("your password was changed", never held back by the per-address limits) says
  when and how, and links to password recovery in case it was not the owner. It carries no token.
- **Logs** name the account by id, never its address; tokens, passwords and links are never logged
  (the logger also redacts credential shapes).

### Sign-up

Public sign-up is OPTIONAL: off unless `SIGN_UP_ENABLED=true`, which requires email (the boot
fails otherwise); off, accounts are created by an operator (`user:create`). When it is on:

- **No account until the address is confirmed.** `POST /api/auth/sign-ups` records a pending
  sign-up (`sign_ups`: address, name, the password's Argon2id hash) and emails a link; the account
  is created only when the link is confirmed. Sign-in, password recovery and the admin list never
  see an unconfirmed sign-up, and an unconfirmed one cannot sign in. One pending sign-up per
  address: a newer one replaces it and its link, unless its own message is held back by the
  per-address limits (then the earlier one stays as it was).
- **No account enumeration.** The answer (202) is the same, byte for byte and at once, for every
  well-formed request whose password follows the policy (400 otherwise, which says nothing about
  the address); the lookup, the hashing and the queueing run after it. An address that already
  has an account gets a notice to its owner ("someone tried to create an account with this
  address"), never a link; the person signing up cannot tell the difference.
- **The confirmation needs the link AND the password chosen at sign-up**
  (`POST /api/auth/sign-ups/confirm`). Someone who signs up with another person's address (to
  pre-claim it) cannot use the account without that person's mailbox; and the person who receives
  a link they did not ask for cannot finish the stranger's sign-up by opening it, because they do
  not know its password. Every attempt is counted before its password is checked, in one atomic
  statement, so requests sent in parallel cannot check more than five; a wrong fifth drops the
  sign-up and its link (and the route is limited per IP like a sign-in). The confirmation creates the account (role `member`)
  and signs it in, ending any session the browser had, like a sign-in.
- **The token:** 256 random bits, minted when the message is sent, only its SHA-256 stored on the
  sign-up; 24 hours, once (the sign-up row is deleted in the transaction that creates the account,
  under its row lock: two confirmations, one account). The link is
  `APP_ORIGIN/app/confirm-sign-up#token=...` (with `APP_BASE_PATH`), handled like a reset link
  (fragment, removed from the address bar and history, memory only, opening it changes nothing).
- **Limits:** 5 sign-ups per 15 minutes per IP, 10 confirmations per 15 minutes per IP; per
  address, one message a minute and `MAIL_DAILY_LIMIT_PER_ADDRESS` a day, shared with password
  recovery. An address that gets an account by other means after the link was sent answers 409.
- **Cleanup:** sign-ups whose link expired a day ago, or whose message never went out, are
  deleted by the hourly sweep.

### Invitations

Administrators invite people from the Invitations page (`/api/admin/invitations`, `@Auth('admin')`:
the role is checked by the API on every route, whatever the web app shows):

- **No account until it is accepted.** An invitation lives in `invitations` (address, role, who
  invited) until its link is accepted; sign-in, recovery and the user list never see it. Inviting
  an address that has an account answers 409 (administrators see every account anyway); inviting
  one again replaces its invitation and link; revoking deletes it and its link at once.
- **The person chooses their own name and password** (`POST /api/auth/invitations/accept`, the
  password policy applies, a refused one keeps the link): the administrator never knows it. The
  **role is fixed by the administrator** and read from the invitation under its row lock when the
  account is created: nothing in the request can change it. An invitation works only while
  **whoever sent it is still an administrator**: a demotion or a deletion voids the invitations
  they sent, with the role they grant. Accepting takes the address's lock, as inviting does, so a
  new invitation cannot be created alongside an acceptance. The acceptance signs the new account
  in, ending any session the browser had, like a sign-in.
- **The token:** 256 bits minted when the message is sent, only its SHA-256 stored on the
  invitation, 7 days, once (the invitation row is deleted in the transaction that creates the
  account: two acceptances, one account; an address that got an account meanwhile answers 409).
  The link is `APP_ORIGIN/app/accept-invitation#token=...` (with `APP_BASE_PATH`), handled like
  every emailed link.
- **Limits:** 30 invitations per 15 minutes per IP; per address, one message a minute and
  `MAIL_DAILY_LIMIT_PER_ADDRESS` a day (an administrator who resends too soon gets 429, and the
  earlier invitation stands); 10 acceptances per 15 minutes per IP. Expired invitations are swept.
- **Logs** name invitations and accounts by id (who invited, who revoked, which account was
  created with which role), never the address.

### Change of email

The Account page changes the address in three steps, built so that a session (and even the
password) in someone else's hands cannot take the account for good:

- **Asking** (`POST /api/account/email`, signed in): requires the current password (403
  otherwise; 5 attempts per 15 minutes per IP). A link valid for 24 hours goes to the **new**
  address; nothing changes until it is opened. If the new address already has an account, its
  owner gets a notice instead and the person asking is answered the same (202, the lookup after
  the answer): no enumeration. Limited per address like every link.
- **Confirming** (`POST /api/auth/email-changes/confirm`, from the new mailbox, signed in or
  not): the token works once and only while the account is as it was when it was sent (same
  address and `security_version`: a password change in between voids it). In one transaction
  under the account's row lock: the address changes, `security_version` increases (every access
  token ends at once), every session ends (sign in again with the new address), the other
  reset and change links of the account are dropped, and the **previous** address gets a notice
  with a link to undo the change. An address taken meanwhile answers 409.
- **Undoing** (`POST /api/auth/email-changes/revert`, from the previous mailbox, within **7
  days**): the previous address comes back **with a new password chosen there** (whoever changed
  the address knew the old one), `security_version` increases and every session ends. Every other
  link of the account is dropped **except the undo links minted before this one**: they undo
  earlier changes, so the earliest owner wins. Whoever took the account and undoes their own later
  change cannot void the owner's link; the owner's link voids theirs (both orders are tested). The
  undo link is **not bound to the account's later state** and is never replaced by a newer one:
  changing the address again or the password does not void it either. A refused password keeps the
  link usable; an address taken meanwhile answers 409.
- **Links and tokens** as for password recovery: 256 bits, minted when the message is sent, only
  their SHA-256 stored (with the target address), after `#`, removed from the address bar and
  history, and opening a link changes nothing (the page's button does). The notice to the
  previous address shows the new one masked (`a•••@example.com`).

### Web client

- **401 handling** (`web/src/auth/middleware.ts`): a 401 to a request that carried a token
  triggers one refresh (shared by every concurrent caller) and one replay; a second 401 signs out.
  A request that went out without a token is left alone; when another request already refreshed,
  the replay uses that token instead of rotating again; and a request is never replayed for
  another user than the one who sent it.
- **One cookie change at a time across tabs** (`web/src/auth/session.ts`): tabs share the cookie,
  and refresh (which rotates it), sign-in (which replaces it) and logout (which clears it) all
  write it, so they take turns through one Web Lock. No tab presents a token another has just
  rotated, and no late answer undoes a newer one: a refresh answered after another tab's sign-in
  would put the old session back, a logout would clear the new one. A refresh gives up after 10
  seconds without an answer, so a stalled one cannot hold the lock for every tab. Without Web Locks
  (or when the browser refuses the lock), one retry covers a race between two refreshes.
- **A rate-limited boot** (`429` on the first refresh of a page) waits out a `Retry-After` of up to
  5 seconds once, then settles as usual: people behind one address share the per-address limit, and
  a `429` says nothing about the session.
- **A refresh survives the page** (`keepalive`): the server rotates the token before it answers,
  so a refresh abandoned by a reload, a navigation or a closed tab would leave the old cookie in
  the jar, read as a lost race at the next page load and as theft 30 seconds later. Its answer
  lands after the page is gone, and the next page's one retry picks up the new cookie.
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
session at once; an access token already issued stays valid until it expires (at most 15
minutes) unless the account's `security_version` changes: a password change or reset increments
it, and `JwtAuthGuard` then refuses every older access token at once. Increment it in the same
transaction for any other change that must end access at once (a role removed, an account
disabled).

### Route protection

`RequireAuth`, `RequireRole` and `GuestOnly` are layout routes. They decide what to **show**; the
API decides what is **allowed**. Never rely on a hidden link or a client guard alone.

## CSRF, CORS, XSS

- **CSRF:** `FetchMetadataGuard` runs first on **every** route (a global guard, before the rate
  limiter): a request whose `Sec-Fetch-Site` says another origin made the browser send it
  (`cross-site`, and `same-site`: a sibling subdomain) is refused with 403 unless its `Origin` is in
  `CORS_ORIGINS`. Browsers that send no Fetch Metadata (Safari before 16.4, and any browser on a page
  served over plain HTTP from a non-local address) still send `Origin` on cross-origin requests and
  on same-origin POSTs: without `Sec-Fetch-Site`, an `Origin` must be the app's own (`APP_ORIGIN`,
  or the scheme and host the request was sent to) or one of `CORS_ORIGINS`, and `Origin: null` is
  refused. Set `APP_ORIGIN` in production: behind the web image, nginx sends the API its own
  upstream name as `Host`, so nothing else tells the API its public origin (it warns at boot
  without it). In development the Vite proxy passes the browser's `Host` through, so a phone on
  the LAN can use the dev server. Requests with neither header pass: non-browser clients carry no
  victim's cookies, and a browser that sends neither still applies SameSite. Bearer-token routes
  cannot be forged anyway (browsers never attach the header), and the API accepts JSON bodies only
  (`common/http/json-only.middleware.ts`, 415 otherwise): HTML forms, the one kind of body another
  site can send without a CORS preflight, never reach a handler.
- **CORS:** off by default. The web app reaches the API on its own origin (Vite proxy in
  development, the web image's nginx in production), and that is the only way it runs: it calls
  `/api` on the page's own origin with same-origin credentials, and its boot reads the
  `has_session` hint, a cookie of the API's host that a page on another origin cannot read.
  **Serving the web app from another origin than the API is not supported**: serve both from one
  host (the web image forwards `/api`). `CORS_ORIGINS` is for another browser client you build,
  sibling subdomains included (same site: the `SameSite=Strict` cookie still travels). A client
  on another _site_ also needs `AUTH_COOKIE_SAMESITE=none` (production only) and third-party
  cookies, which Safari blocks by default and other browsers block in private windows or by user
  choice: there it cannot renew its session, and its users sign in again at every page load. Give
  such a client a proxy to the API on its own origin instead.
- **XSS:** React escapes output; never use `dangerouslySetInnerHTML` without a sanitizer (OPCIONAL:
  DOMPurify). The web image sends a strict CSP (`default-src 'self'`, no inline scripts, no
  framing) on the landing and the app alike; widen it per directive, in review, when a feature
  needs it. The landing keeps within it by construction: static HTML, stylesheets as files, no
  script, nothing from another origin (its JavaScript budget is 0 kB).

## Security headers and caching

API: helmet defaults (CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
CORP/COOP, no `X-Powered-By`) and `Cache-Control: no-store` on every response (they carry tokens
and personal data). Web image: CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer` (pages are opened from one-time links), `Permissions-Policy`, COOP
(`apps/web/nginx/security-headers.conf`), on every page of the landing and the app; hashed
assets (`/app/assets/`, `/_astro/`) cached for a year, never an error response. Redirects carry a
path only (`absolute_redirect off`): never an address built from the request's `Host`. The landing's
absolute links take the configured `APP_ORIGIN`, written in by nginx as it serves them, never the
request's `Host` either. The CSP's `connect-src` gains exactly one origin
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

`@nestjs/throttler`, per client IP and per route, by two throttlers that both count
(`common/guards/rate-limit.guard.ts`): the global limit on every route, `RATE_LIMIT_MAX` per
`RATE_LIMIT_WINDOW_SEC` (default 100/60 s), and on top of it a tighter limit of the route's own,
declared with `@RouteRateLimit`: sign-in 10/min, refresh 30/min, Web Vitals 60/min. Whichever runs
out first blocks; health probes are exempt; `429` with `Retry-After`. Never set a route's limit
with `@Throttle({ default: ... })`: that replaces the global limit for the route instead of adding
to it.

The counters live in a **store** chosen by `RATE_LIMIT_STORE`
(`infrastructure/rate-limit/rate-limit.store.ts`); the guard, the limits and the routes are the same
with either:

| Store              | When                                                                         | Behavior                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory` (default) | one instance                                                                 | the throttler's in-memory store, as the template always had                                                                                 |
| `redis`            | several instances (needs `REDIS_URL`; development and the VPS target use it) | shared counters: a client cannot multiply its allowance by the number of instances; same algorithm, atomically in a Lua script, server time |

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
never the `*Unsafe`variants with interpolated input: an ESLint rule refuses them everywhere,
scripts and tests included. The one use,`$executeRawUnsafe` in the test reset helper, interpolates
table names read from the database catalog (identifiers cannot be bound as parameters) and carries
a disable comment that says so.

## Database access

The API connects as a role that reads and writes data and cannot change the schema (`app_runtime`),
the migration job as the schema's owner (`app_migrator`): neither is a superuser, and each gets only
its own `DATABASE_URL` ([disaster-recovery.md](disaster-recovery.md#backup-strategy)). The same
roles everywhere, made three ways: by hand on a managed database, by `pnpm iac:database` on
Terraform's, and by `deploy/vps/db-init.sh` on the VPS target's own
([deploy-vps.md](deploy-vps.md#5-the-database)), which adds `app_backup`, read-only, for the nightly
backup. There PostgreSQL is on the server's internal network only, never published, and asks every
container for its password; its superuser is reached only through the database container.
`pnpm iac:check` runs both role scripts on PostgreSQL in CI and fails when a role can do more than
its share ([ci-cd.md](ci-cd.md#infrastructure-as-code)).

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
- Never in Terraform's files or outputs: the DigitalOcean token comes from `DIGITALOCEAN_TOKEN`
  only, the generated database passwords are sensitive outputs, and the state that holds them stays
  out of git (`*.tfstate*` in `.gitignore`), on the operator's disk or in a private Spaces bucket
  ([deploy-vps.md](deploy-vps.md#state)).
- In production: the platform's secret store or the GitHub environment secrets, one value per
  environment (docs/environment.md#secrets); on the VPS target, files on the server readable by the
  deploy user only, one per container with only what it needs
  ([deploy-vps.md](deploy-vps.md#the-files)). Rotation: [Secret rotation](#secret-rotation).
- A leaked secret is rotated first, then removed from history if needed; removal alone is not enough.

## Logging

Logs, error reports and spans leave the process; credentials must not. Three layers, in order:

1. **Nothing sensitive is logged on purpose:** the access log records method, path (no query
   string), status, duration, IP and user id; error lines record the stack; no code logs headers,
   cookies, bodies, tokens or env values (review rule, ENGINEERING_STANDARDS.md).
2. **Automatic redaction** (`apps/api/src/observability/redact.ts`) of everything the logger prints, whatever a
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

## Web Vitals

`POST /api/telemetry/web-vitals` is public: the web app sends the Web Vitals of its page loads
there with `navigator.sendBeacon`, signed in or not (docs/observability.md#web-vitals). What
protects it:

- **The rules of every route:** the Fetch Metadata guard refuses what another site made a browser
  send, only JSON bodies are accepted (a beacon of a JSON `Blob` is), bodies are capped at 100 kB,
  and the global rate limit applies, with a limit of the route's own on top: 60 a minute.
- **A strict schema, bounded values:** known metric names, values within what a page load can
  measure (two minutes, a layout shift of 50), at most 10 per batch, no field but those of the
  contract; anything else is a 400 and nothing is recorded.
- **Bounded labels, no personal data:** the page is a route pattern from a closed list (the app's
  routes), never a URL, a path value or a query string, so ids, emails and tokens in a URL never
  leave the browser; the rating is computed by the API. The metrics identify no visitor: no user
  id, no session, no user agent in them. The browser attaches its cookies to a same-origin beacon,
  but the route reads none. Like every request, a beacon is in the access log with the client's IP
  (and, with tracing on, in a server span with the IP and the user agent): it serves the rate limit
  and the logs, never the metrics.
- **Nothing stored but metrics:** the values become histogram samples, aggregated per label set. A
  client can at worst skew the distribution of the pages it reports, within the rate limit.

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
  attributes lose their query string and credentials; values under a sensitive name are masked
  whole and every other string attribute (string arrays included) is redacted, on the span, on its
  events (exception messages and stack traces) and in its status message
  (`RedactingSpanProcessor`). The resource names the process (`service.instance.id`), not the
  machine: no host name or machine id unless the operator sets one. Provider credentials
  (`OTEL_EXPORTER_OTLP_HEADERS`) are read by the exporters from the environment, never by
  application code.

## Redis

OPTIONAL for the application (docs/architecture.md#redis), and on by default in development and on
the VPS target. Secure defaults in all three places:

| Concern             | Development (`pnpm services:up`)                                                     | The VPS target (`deploy/vps`)                                                                                                | Elsewhere (REQUIRES CONFIGURATION)                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where               | a container on this machine                                                          | a container on the server, beside the API                                                                                    | a managed or private Redis (ElastiCache, Memorystore, Azure Cache, Upstash...) on the private network only, never a public endpoint              |
| Network             | published on 127.0.0.1 only (port 6389)                                              | the internal network `data` only, never published                                                                            | reachable from the API's network only (security groups, private endpoints)                                                                       |
| Authentication      | a password (`REDIS_PASSWORD` in the root `.env`; `app` when unset, development only) | an ACL user, `app`, limited to `~app:*` and the commands the adapters run; the default user off; its password in `redis.env` | an ACL user limited to the key prefix and the commands the adapters run (list in docs/architecture.md#redis), its password from the secret store |
| Encryption          | none (loopback)                                                                      | none: the internal network stays on the server (the boot warning about `redis://` is expected)                               | TLS: `rediss://` (the API warns at boot about `redis://` in production)                                                                          |
| Credentials in logs | never: the URL is logged as host:port, errors are redacted                           | same                                                                                                                         | same                                                                                                                                             |
| Persistence         | AOF every second, a volume                                                           | AOF every second, the volume `app_redis_data`                                                                                | per use: cache and rate limits can lose data; locks and idempotency claims should survive a restart (AOF or the provider's persistence)          |
| Memory              | 256 MB, evicts only keys with a TTL (`volatile-lru`)                                 | the same, in a container limited to 512 MB                                                                                   | sized to the workload, with the same policy: every key the template writes has a TTL, so keys without one (a future job queue) are never evicted |
| Process             | runs as the `redis` user; password passed through a file, not the command line       | the same, with the server's hardening ([Container images](#container-images)); the ACL file on a `tmpfs` only Redis reads    | the provider's hardening                                                                                                                         |

The application treats Redis as untrusted for correctness: losing it degrades features but never
authorizes a request, and no session or authorization data lives there.

## Email

OPTIONAL infrastructure ([architecture.md](architecture.md#email), ADR
[0003](adr/0003-transactional-email-outbox.md)). Development uses Mailpit, which accepts anyone's
mail without authentication: it is published on 127.0.0.1 only and is never part of a deployment.

| Concern                | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport              | Production requires encryption: `smtps://`, or `smtp://` with STARTTLS required (a server without it, Mailpit among them, is refused); TLS 1.2 or later; the server's certificate is verified. The one exception is a server on the machine itself (`localhost`, `127.0.0.1`, `[::1]`: a local relay, the end-to-end suite's Mailpit): that traffic never crosses a network, and `localhost` is connected to as `127.0.0.1`, never through a DNS answer. In production the API warns at boot when it uses the exception (a copied development setting). |
| Credentials            | In `MAIL_SMTP_URL`, a secret of the platform's store; the logger redacts `user:password@` in any URL, and the SMTP server's own text is never logged (only a category such as `smtp_5xx_535`).                                                                                                                                                                                                                                                                                                                                                          |
| Links                  | Built from `APP_ORIGIN` and `APP_BASE_PATH` only (required with email; https in production, http only on a loopback origin, where links open on that machine alone), never from a request's Host or forwarded headers: no password-reset poisoning (see [HTTPS](#https)).                                                                                                                                                                                                                                                                               |
| What the outbox stores | No message body and no token: the worker renders a message when it sends it, and a link's token is minted then, only its hash stored. The address is cleared once the message is sent or dropped (a CHECK constraint enforces it), a keyed hash (HMAC-SHA256, key derived from `JWT_ACCESS_SECRET`) stays for the per-address limits.                                                                                                                                                                                                                   |
| Logs, metrics, errors  | A message is named by its id and kind; an address appears at most as the first 12 characters of its keyed hash. Metric attributes are the kind and the outcome only. `mail status` prints no address. Database errors are logged by class and code, never their message (it can quote a query's arguments).                                                                                                                                                                                                                                             |
| Content                | Every value in a template is HTML-escaped; subjects carry no line break (no header injection); nothing remote is loaded (no image, font or stylesheet: no tracking pixel); nodemailer may not read files or URLs named in a message. `MAIL_FROM` is validated at boot, quotes and line breaks refused.                                                                                                                                                                                                                                                  |
| Abuse                  | Messages anyone can request are limited per mailbox (one a minute, `MAIL_DAILY_LIMIT_PER_ADDRESS` a day; a `+tag` counts as the same mailbox), counted in PostgreSQL so every instance shares them, on top of the routes' per-IP limits. Callers answer the same whatever was queued: no account enumeration through email. Security notices are never held back, and workers send them before the others.                                                                                                                                              |
| Automatic replies      | `Auto-Submitted: auto-generated` and `X-Auto-Response-Suppress: All` on every message (RFC 3834).                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Sender authentication  | REQUIERE CONFIGURACIÓN: SPF, DKIM and DMARC for the sending domain at the provider, before the first message; without them messages are spoofable and land in spam.                                                                                                                                                                                                                                                                                                                                                                                     |
| Retention              | Finished outbox rows (metadata: kind, status, attempts, timestamps, error category, keyed hash) are deleted after 30 days; a failed message's address is cleared after 7; a message never sent a day past its validity (email turned off since) is dropped and its address cleared. The sweep runs whether email is on or off.                                                                                                                                                                                                                          |

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

| Control                        | What it stops                                                                                                                            | Where                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Frozen lockfile                | Installing anything the reviewed `pnpm-lock.yaml` does not list, with its sha512 integrity                                               | `.github/actions/setup` (`--frozen-lockfile`)                                |
| Registry sources only          | A dependency from a git repository, a tarball URL or a folder (no registry integrity, no release delay)                                  | `blockExoticSubdeps` (transitive), `deps:check` (direct)                     |
| Release delay (seven days)     | A hijacked release, usually detected and unpublished within days; exemptions are exact versions that expire                              | `minimumReleaseAge`, Dependabot `cooldown`, `deps:check` (exemptions)        |
| Trust downgrade refused        | A new version published with weaker evidence than earlier ones (provenance lost: a stolen token)                                         | `trustPolicy: no-downgrade`                                                  |
| Install scripts allowlisted    | Code running at install time without a reviewed decision                                                                                 | `allowBuilds`                                                                |
| Optional dependencies left out | An optional package nobody uses, with its install-time binaries and their licenses (sharp, Astro's raster image optimizer: LGPL libvips) | `ignoredOptionalDependencies`                                                |
| License policy                 | A license the product cannot ship: production dependencies need a permissive license, tools may also use weak copyleft; unknown fails    | `deps:check`, `scripts/dependency-policy.json`                               |
| Known vulnerabilities          | High and critical advisories                                                                                                             | `pnpm audit`, Trivy on the images                                            |
| Weakened settings              | Lowering the delay, dropping the trust policy or the block on exotic sources; removing the Dependabot cooldown                           | `deps:check` (floors in `scripts/dependency-policy.json`); zizmor (cooldown) |

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
Docker Compose, the tool images (`.github/tool-images/Dockerfile`, tag and digest) and the Terraform
providers (`infra/terraform`, version and lock-file checksums together). Version updates wait the
same seven days as pnpm; **security updates** (Dependabot alerts) are not delayed.
Majors arrive one per pull request, with their release notes to read. A person still approves every
update: once approved and green, a patch or minor update merges itself
([ci-cd.md](ci-cd.md#dependency-updates)); majors and workflow updates are merged by hand.
Some majors are never proposed, because they move by hand with what depends on them
([ci-cd.md](ci-cd.md#keeping-the-stack-current)): `@types/node` and the Node.js base image of the
Dockerfiles follow `.nvmrc` and `engines` (a Node.js major can drop what the images rely on:
Node.js 25 no longer bundles corepack, which installs pnpm in them); PostgreSQL and Redis move in
CI and Compose together, and PostgreSQL with the managed database and its data.

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
  the production dependencies and the compiled API; the migration image the production dependencies
  (the Prisma CLI is one), the CLI's schema engine and the migrations, with no source code and no
  development tools. That engine is the one built for OpenSSL 3 and links Debian's `libssl3`, so the
  TLS of the migrations gets the system's fixes and the image scan sees it (the engine Prisma picks
  on a system without OpenSSL carries its own copy, out of reach of both: the build refuses it). The
  Prisma CLI's update check and usage data are off there (`CHECKPOINT_DISABLE=1`), in the image
  builds and in CI. Every image applies the operating system fixes published after its base was
  built (`apt-get upgrade` in the API and migration images, `apk upgrade` in the web image), so a
  fixed advisory in the base does not wait for the next base release. CI passes the day as
  `OS_UPGRADE_DATE`, part of that step's cache key: the build cache replays an upgrade for one day
  at most, never until the base digest changes.
- The files of an image belong to root: the user it runs as can read and run them, never change
  them. On the server (`deploy/vps/compose.yaml`) every container also runs with:
  - a read-only root filesystem, with a small `tmpfs` only where the process writes (`/tmp`,
    nginx's generated configuration, PostgreSQL's socket directory), emptied at every restart; the
    data of PostgreSQL, its backups and Redis on their own volumes;
  - no Linux capability (`cap_drop: [ALL]`), except Caddy's `NET_BIND_SERVICE` for ports 80
    and 443;
  - `no-new-privileges`, so a setuid binary grants nothing;
  - limits on processes and memory, so one runaway container cannot take the server down.

  An intruder in a container therefore cannot change the application, plant a persistent tool or
  gain privileges inside it.

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
  `main`, re-runs every gate on that exact commit and releases that commit only, with the image
  digests its own build reported or an earlier run of it from `main` recorded: never the registry
  tag `<image>:<sha>`, which any workflow with `packages: write` can push from any branch. The
  workflow file's own checks can be edited on a branch, so the environments must also allow
  deployments from `main` only (docs/ci-cd.md#repository-settings-requiere-configuración).

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
Docker's file sharing. Symbolic links are not followed. An nginx template (`*.conf.template`) is
copied under the name nginx renders it to (`default.conf.template` as `default.conf`): the nginx
rules only read `*.conf` files, and would otherwise skip the configuration the web image runs.
Any finding fails: on this code base the rulesets report nothing, so a finding is worth a look. A
false positive is suppressed on its line with the reason, which review sees:
`// nosemgrep: <rule-id> -- why it is safe`. The rulesets are fetched from the Semgrep registry at
each run, so a new rule can flag existing code; fix or suppress it in its own pull request.

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

| What                                    | Status                              | How                                                                                                                                                                                                             |
| --------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lockfile integrity                      | Obligatorio                         | sha512 per package, frozen installs, registry sources only ([Dependency policy](#dependency-policy))                                                                                                            |
| SBOM of each release                    | Obligatorio                         | CycloneDX of the npm packages the production dependencies resolve to at the tag, attached to the GitHub release by `release.yml` (`pnpm sbom:generate` locally)                                                 |
| SBOM and provenance of published images | Obligatorio once images are pushed  | BuildKit attestations (`sbom: true`, `provenance: mode=max`) on every push (the `publish` job of `deploy.yml`, `docker-images.yml` with `push: true`), in the image index whose digest is recorded and deployed |
| Scanned image = shipped image           | Obligatorio                         | The VPS deployment scans the digest it pushed and deploys that digest from the run's record; production reuses staging's record, never the mutable tag, and scans it again                                      |
| Signed attestations (Sigstore)          | OPCIONAL                            | `actions/attest-build-provenance` step ready (commented) in `docker-images.yml`; the `publish` job of `deploy.yml` needs the same step after its push. Needs a public repository or GitHub Enterprise Cloud     |
| Verification before deploying           | OPCIONAL (with signed attestations) | `gh attestation verify oci://<image>@<digest> --repo <owner>/<repo>` in the release job of `deploy.yml`                                                                                                         |

Signing with a separate tool (cosign with keys) is not included: GitHub attestations are already
Sigstore signatures, verifiable without managing keys. To see what a pushed image carries:
`docker buildx imagetools inspect <image>@<digest> --format '{{ json .Provenance }}'` (or
`.SBOM`).

**Which SBOM describes what runs.** The release's CycloneDX file lists the npm packages of the
lockfile that the production dependencies need, peer dependencies included (so a few build tools,
TypeScript among them, appear): what a review of the code's dependencies needs, the same whenever
the tag is built. It does not list what an image adds (the Debian or Alpine packages, Node.js,
nginx), and it names no image. Each image's own SBOM does: BuildKit scans the image's files when it
is built and stores an SPDX document, with the SLSA provenance of the build (the commit, the
Dockerfile, the build arguments, the base images), in the image index next to the image. The
digest the Deploy workflow records and deploys is that index's, so the command above, with the
digest of `release.env` or of the run's summary, shows the SBOM of exactly what runs. Checked
with a build of this repository: the pushed digest is the index, which lists the image and an
attestation manifest that references it; the api image's SBOM lists 424 packages: 334 npm, 88
Debian, and Node.js itself.

**What an SBOM proves, and what it does not.** It is an inventory: the components a scanner found,
with versions and identifiers, so a new advisory can be matched against what runs and "do we ship
X?" has an answer. It does not prove that the components are free of vulnerabilities (the Trivy
scan covers the known ones that have a fix), nor that the list is complete (code copied outside a
package manager, or linked into a binary, can be missed), nor who built the artifact or from what
(that is the provenance), nor that nobody changed it: BuildKit's attestations are not signed. They
are worth what the digest that leads to them is worth: the digest fixes their content, and it
comes from a run of `deploy.yml` on `main` (`scripts/recorded-images.mjs`). A signed attestation
(above) lets anyone check where an image comes from without access to that run.

## Known limits

Accepted on purpose, each with its way out:

- **Access tokens outlive a session revocation** by up to 15 minutes, except a password change or
  reset, which ends them at once (`security_version`). Way out: increment it for the other changes
  that need that (see [Authorization](#authorization)), or a shorter TTL.
- **Rate limits are per IP**, and per instance with the default memory store (and while a Redis
  store is unreachable). A distributed credential-stuffing attack (many addresses) is not
  stopped. Way out: `RATE_LIMIT_STORE=redis`, per-account limits, CAPTCHA or MFA.
- **Redaction recognizes credential shapes, not all personal data**: an email or a name written
  into a log message stays readable. Way out: log ids (review rule).
- **No MFA, no account lockout**: product work (see Authentication). **Sign-up has no CAPTCHA:**
  automated sign-ups are bounded by the per-IP and per-address limits and need a working mailbox
  to finish; a project that sees abuse adds a challenge (REQUIERE CONFIGURACIÓN). Someone can keep
  replacing the pending sign-up of an address they do not own (each costs them a request within
  the limits), delaying its owner's sign-up, never taking it.
- **The per-address email limits can be spent by anyone.** They keep a mailbox from being flooded
  (one message a minute, `MAIL_DAILY_LIMIT_PER_ADDRESS` a day, shared by password recovery and
  sign-up), and so whoever asks for that many messages for an address keeps further ones from it
  until the window passes: its owner's reset link waits too. Bounded per IP, not across many. Way
  out: a higher daily limit, a challenge on the public forms, or an operator-sent link.
- **An undo link outlives the change it undoes for 7 days**, by design (no later change can void
  it): the person who controls the previous mailbox in that window can take the address back.
  After the window, or if that mailbox is lost too, recovery is an operator's job.
- **A link stays in the browser's own history** (and its sync): the page removes the token from the
  address bar and the back button, but the browser recorded the visited address with it. On a
  shared computer an unused link could be reopened from there until it expires; a used one is
  worth nothing. Way out: the short validities (30 minutes for a reset), and using links at once.
- **Provider-specific address forms** (Gmail's dots, other providers' aliases) are different
  mailboxes to the per-address limits; only `+tags` are folded. **No breached-password
  service:** the policy refuses the most used passwords from a local list, so a password leaked
  elsewhere but not common passes. Way out: a k-anonymity range check (OPCIONAL; it sends a hash
  prefix to a third party).
- **A password change in one tab while another tab renews its session** at that very instant can
  leave the older cookie in the browser: that session ended on the server, so the browser asks to
  sign in again (with the new password). The change does not take the cross-tab lock, which an
  expired access token's renewal would wait on forever (`web/src/auth/session.ts`).
- **A refresh response lost on the network** (the server rotated the token, the connection
  dropped before the answer arrived) looks like theft once 30 seconds have passed: the family
  ends and the user signs in again. That is the price of reuse detection (RFC 9700 accepts it);
  raise `REFRESH_REUSE_LEEWAY_SEC` only with a reason. A reload or a closed tab does not lose it:
  the web app sends its refreshes with `keepalive`.
- **Email is delivered at least once**: a worker that dies after the SMTP server accepted a
  message and before recording it sends it again when its lease ends (same `Message-ID`). Links
  stay single-use, so a duplicate does no harm beyond the noise.
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
- [ ] `CORS_ORIGINS` / `AUTH_COOKIE_SAMESITE` only for another browser client on another origin;
      the web app itself is served on the API's origin ([CSRF, CORS, XSS](#csrf-cors-xss)).
- [ ] More than one server: `RATE_LIMIT_STORE=redis` on a Redis they all reach, private,
      authenticated and over TLS (the VPS target's own Redis serves one server).
- [ ] The VPS target's own database: its nightly backups copied off the server
      ([deploy-vps.md](deploy-vps.md#backups)).
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

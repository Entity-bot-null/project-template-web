# 0004. End access tokens at once on a credential change, with a security version

- **Status:** Proposed
- **Date:** 2026-10-12
- **Deciders:** template maintainers

## Context

Access tokens are JWTs verified offline, valid for 15 minutes. Ending a user's sessions revoked
their refresh tokens, but every access token already issued kept working until it expired. For a
password reset that window is the problem itself: the person resets because someone else may be
signed in, and that someone keeps full access for up to 15 more minutes. OWASP ASVS (session
management) and NIST SP 800-63B-4 expect the other sessions to end when a credential changes.
Password recovery and change (this PR) are the first features that need it; email change and
account deactivation will too.

## Options

1. **Keep offline verification, shorten the TTL** (for example to 2 minutes): no lookup; but the
   window only shrinks, and every client refreshes far more often (one rotation per tab every 2
   minutes, each one a write).
2. **A denylist of token ids** (`jti`) in Redis or PostgreSQL: precise per token; but it needs an
   id on every token, a list kept until each token expires, and Redis, optional today, becomes
   load-bearing for security, or a table write per revocation and a lookup per request anyway.
3. **A per-user security version**: `users.security_version`, carried in the token (`sv`) and
   compared on every authenticated request (one primary-key lookup); incremented in the same
   transaction as any change that must end access. One integer per user, no list, no new
   infrastructure; one-time tokens record it too, so a link minted before a change stops working.

## Decision

Option 3. It ends access exactly when the change commits, uses the database the guard can already
reach, and gives every future flow (email change, deactivation, a role removed) the same lever:
increment the version in the change's transaction.

## Consequences

- Every authenticated request costs one indexed read of `users` (by primary key). The guard
  answers 401 when the account is gone or its version moved, and the web app's existing 401
  handling refreshes once: tokens issued before this change (without `sv`) are renewed
  transparently after the deployment.
- The API cannot authenticate a request with the database down. It already could not serve one:
  every protected route reads it.
- The version is not a counter of anything else: never reset it, never decrement it (a CHECK
  keeps it non-negative). Tests mint tokens with `asUser(app, id, role, sv)`.
- Wrong if the lookup shows up as a meaningful share of request latency: then cache the version
  per instance for a few seconds (bounded staleness) or move it to Redis, keeping the same claim.

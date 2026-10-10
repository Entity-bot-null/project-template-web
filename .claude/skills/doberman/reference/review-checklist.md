# Review checklist

The questions to ask of every significant change. They are prompts, not a form: answer the ones
the change makes relevant, and go deep where the risk is. Template-specific invariants and flows are
in [template.md](template.md); they take precedence over the generic wording here.

## Contents

- [Before judging: the flow](#before-judging-the-flow)
- [Correctness](#correctness)
- [Edge cases](#edge-cases)
- [Concurrency and races (mandatory for async code)](#concurrency-and-races-mandatory-for-async-code)
- [Cancellation](#cancellation)
- [Authentication and authorization](#authentication-and-authorization)
- [API contract](#api-contract)
- [Validation](#validation)
- [Errors and UI states](#errors-and-ui-states)
- [Data and state consistency](#data-and-state-consistency)
- [Performance](#performance)
- [Observability](#observability)
- [Security](#security)
- [Test quality](#test-quality)
- [Coverage](#coverage)
- [CI/CD and gates](#cicd-and-gates)
- [False-positive protocol](#false-positive-protocol)
- [Severity](#severity)

## Before judging: the flow

Never evaluate a changed line alone. For each feature the change touches, trace it end to end along
the template's flow (template.md) and read the pieces outside the diff that its behavior depends
on: callers, the hook or service it calls, the API client, auth and session, the cache, the list
or screen that shows the result, sign-out, the tests. Stop at pieces with no relation to the change.

Write down, per feature: the states it goes through (idle → pending → success/error → …), what
triggers each transition, and which component owns each piece of state. Most real bugs are an
unplanned transition: a response arriving in a state that no longer expects it.

## Correctness

- Does it do what the pull request and the issue promise, for every input the type allows?
- After an error? After a retry? After a cancellation? After a token refresh? After sign-out and a
  new sign-in? With partial data, `null`/absent optional fields, an empty list, the maximum size?
- With a response the client did not expect (extra fields, missing fields, wrong status, HTML from
  a proxy, an empty body)?
- Can any path leave state half-updated: a write done and its cache update not, a flag set and
  never reset, a listener added and never removed, a lock taken and never released?
- Off-by-one in pagination, dates and time zones, rounding, string length vs bytes.

## Edge cases

Look specifically for: double click / double tap, double submit, the same request twice, immediate
cancellation, cancellation mid-operation, timeout, a slow response, a response that never comes, a
late response, responses out of order, unmount during the request, fast navigation back and forth,
sign-out during the operation, a different user signing in during the operation, an expired token,
two refreshes at once, retries, stale data, a resource deleted or replaced while the operation runs,
a resource already deleted, a resource changed by another operation.

## Concurrency and races (mandatory for async code)

For every asynchronous feature in the change, answer each of these with the code in front of you:

1. Two requests for the same thing in flight: which one wins, and is that the right one?
2. Responses out of order: can an older response overwrite the result of a newer one?
3. Is an abort signal passed all the way to the network call? Does the code after `await` check
   whether the result is still wanted (request id, generation counter, mounted flag, query key)?
4. Retries: can a retried request apply its effect twice? Is the operation idempotent, or keyed?
5. Token refresh: concurrent 401s share one refresh? A refresh that lands after sign-out is
   discarded?
6. Sign-out and account switching: can anything that started for user A write state, cache, storage
   or UI that user B will see?
7. Optimistic updates: are in-flight queries for the same data cancelled first, so they cannot
   overwrite the optimistic value? Does the rollback restore the right snapshot when two mutations
   overlap?
8. Cache invalidation: is the right key invalidated after the write, and not before it lands?
9. Duplicate mutations: is the submit control disabled or the mutation deduplicated while pending?
10. Background work (timers, intervals, listeners, subscriptions): stopped on unmount and sign-out?

Then the timeline cases. For an operation with a start request, an optional secondary operation and
a cancel request, check what happens when the cancellation comes:

1. before the operation starts;
2. while it runs;
3. after a secondary operation started;
4. while the start request is slow;
5. after the start request failed;
6. while the start request never answers;
7. while the cancel/DELETE request is slow;
8. with a response landing after a new operation started;
9. after the authenticated user changed;
10. after the resource changed while the operation was still active.

An `AbortController` in the code proves nothing by itself: check that its signal reaches the
request, that an abort before sending is honored, and that the code after the `await` does not
write state when the operation was cancelled.

## Cancellation

- Who cancels what: unmount, navigation, a newer request, the user, sign-out, a timeout.
- Is cancellation reported as an error to the user (it should not be), or swallowed silently where
  the caller needed to know?
- Is cleanup idempotent (cancel twice, cancel after completion)?
- After cancelling, is the UI back in a consistent state (no spinner forever, no disabled button)?

## Authentication and authorization

- Every protected operation requires a session, and the check is on the server (the client is
  never the only authority).
- Object-level access: can a user read or change someone else's record by changing an id?
- Roles: allowed role, forbidden role, anonymous, another user's record.
- Tokens: where they live, how they rotate, what happens to them at sign-out, whether anything
  logs, persists or sends them where it should not.
- Session expiry while a screen is open; refresh failure for a transient reason (offline) vs a
  rejection (signed out).

## API contract

- The contract file and the generated types change together, regenerated by the template's command,
  never edited by hand.
- Request and response compatibility: renamed or removed fields, nullable vs optional, new required
  request fields, enum values added (clients must tolerate unknown values) or removed, status codes,
  error envelope, pagination shape, id formats.
- Backwards compatibility with clients already deployed (installed app versions, open browser tabs)
  or a coordinated, documented break.
- Authorization requirements declared on new operations.
- Frontend and backend (or app and mock API, fixtures) in step: no silent drift.

## Validation

- Every external input validated at the boundary with a schema: request bodies and queries, route
  parameters, responses from the API, links, notification payloads, files, environment variables.
- Sizes bounded (strings, arrays, page sizes, uploads); formats checked (ids, emails, URLs).
- Output built from an explicit selection, never an internal object spread into a response.

## Errors and UI states

- Expected errors (validation, not found, conflict, unauthenticated, forbidden) vs unexpected ones
  (bugs, server errors, network, timeout, abort): each has its path and its message.
- The UI represents loading, success, empty, error, retry and cancelled; errors are announced to
  assistive technology; a retry does not lose the user's input.
- Failures are reported once (no duplicate reports, no silent swallowing).

## Data and state consistency

- Server state stays in the server-state layer; local copies drift.
- Cache keys include every parameter the data depends on; invalidation covers every list or detail
  that shows the changed data; deleted and replaced resources disappear from every cached view.
- Persistence: what survives a restart, a sign-out, an app update (stored data from the previous
  version still loads or is migrated).
- Sign-out and user switching clear everything that belonged to the previous user.
- An old operation must never overwrite the result of a newer one.

## Performance

Only what the change touches:

- Re-renders caused by unstable props or selectors; heavy work during render.
- N+1 requests, duplicate requests, polling without backoff or stop, unbounded queries.
- Unbounded arrays or caches, listeners or timers that leak, large payloads, unnecessary
  serialization, large images or media.
- Lists that should be virtualized; bundle growth from a new dependency (the budget gate measures
  it).
- Over-eager cache invalidation that refetches everything after every write.

## Observability

- Unexpected errors reach the error tracker once, with context that helps (ids, operation), and
  without tokens, passwords, secrets or unnecessary personal data.
- Logs through the template's logger; redaction not bypassed (no raw `console.log` of objects that
  may contain secrets).
- New failure modes are visible (an error report, a metric or a log line someone would look at).

## Security

Beyond auth: secrets in code, config or bundles; injection (SQL, shell, HTML, URL); open redirects
and untrusted links; insecure transport; permissive CORS or CSRF gaps; new dependencies (needed,
maintained, license, install scripts, supply-chain settings untouched); new permissions; workflow
changes that widen permissions, add secrets to pull request triggers or unpin actions.

## Test quality

Existing tests are evidence only if they would fail when the code is wrong:

- Do they assert behavior (what a user or caller observes) or implementation details?
- Do they cover failure paths, edge cases, races, cancellation, auth (allowed, forbidden, anonymous,
  other user's record), stale state?
- Misleading tests: a stub that always answers instantly hides races; a stub that ignores the abort
  signal hides cancellation bugs; a mock of the unit under test proves nothing; a snapshot passes on
  real bugs; an assertion inside a callback that never runs passes vacuously; `waitFor` around a
  condition that is already true proves nothing.
- A bug fix comes with the test that failed before the fix.
- Was a test, threshold, lint rule or type weakened, skipped or deleted to make a check pass?

## Coverage

Read the coverage of the changed lines (`doberman.mjs coverage`), not the global percentage.
Uncovered changed lines matter when they are auth, cancellation, error, race-sensitive or data-loss
paths; an uncovered log line does not. Coverage measures what ran, not what was checked: judge it
together with the test quality above. Never ask for 100 %.

## CI/CD and gates

- Workflows: least privilege `permissions`, actions pinned by SHA, no `pull_request_target`, no
  secrets in pull request triggers, user-controlled values through `env` and not `${{ }}` in `run:`,
  no path from a pull request to a release.
- No gate removed or weakened (scripts, thresholds, ignore files, `nosemgrep`, `eslint-disable`,
  supply-chain settings) without a reason on the same line and a human reviewer.
- A gate already in CI is not duplicated elsewhere without a reason.

## False-positive protocol

Before recording a finding:

1. Read the context around the code, not just the hunk.
2. Follow the whole flow (callers and callees).
3. Check the types: the compiler may already exclude the case.
4. Check every caller: the problematic input may never reach it.
5. Read the existing tests: the case may be covered.
6. Try to reproduce it.
7. Look for an existing protection elsewhere (a guard, a schema, a lock, a server check).

If the evidence shows the problem does not exist, do not report it. If it cannot be shown either
way, report it as UNVERIFIED with what would settle it.

## Severity

| Severity   | Use for                                                                                                                                                                                                                                           | Never for                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| BLOCKING   | data corruption or loss; security vulnerability; authorization bypass; broken authentication; data of one user visible to another; critical race; crash; the main functionality wrong; broken contract; a mandatory gate failing; a weakened gate | style, naming, preferences            |
| SHOULD FIX | a relevant edge case; incomplete error handling; stale state; significant performance cost; an important missing test; a rule of the repository broken without user impact yet; important maintainability problem                                 | speculative problems without evidence |
| LOW        | minor problems that do not block merging                                                                                                                                                                                                          | anything with user impact             |
| NIT        | style, clarity, preference                                                                                                                                                                                                                        | blocking a merge (nits never block)   |

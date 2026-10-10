# Reproducing a suspected bug

A suspicion becomes a finding when a test shows it. This guide is for this template's test stack
([docs/testing.md](../../../../docs/testing.md)): Vitest + Testing Library (jsdom) in `apps/web`,
Vitest unit specs and supertest integration specs in `apps/api`.

## Contents

- [Rules](#rules)
- [The file](#the-file)
- [Running and classifying](#running-and-classifying)
- [Web patterns](#web-patterns)
- [API patterns](#api-patterns)
- [Validating the fix (optional)](#validating-the-fix-optional)
- [What cannot be reproduced here](#what-cannot-be-reproduced-here)

## Rules

1. The test asserts the **correct** behavior: it fails while the bug exists and passes once it is
   fixed. A test that asserts the bug proves nothing about a fix.
2. Realistic, through the real code. Web: stub `fetch` (`stubFetch`), render the real route tree
   (`renderRoute`) or component with the real session store and API client. API: the real
   application over HTTP (`createTestApp`) against the test database, or the real service class
   with fakes only for what is outside it.
3. Model time and order explicitly: held responses (`deferred()`), responses released out of order,
   aborts, a response that never comes, two requests at once (`Promise.all`). An instant stub
   hides races; a stub that ignores the abort signal hides cancellation bugs.
4. Never edit an existing file (spec, helper, production code) to reproduce. Everything the test
   needs goes inside the temporary file.
5. One scenario per test, named after the expected behavior.

## The file

- Names: `<subject>.doberman.spec.ts(x)` for web and API unit specs,
  `<subject>.doberman.int.spec.ts` for API integration specs, next to the code under test inside
  `apps/web/src/` or `apps/api/src/` (each runner only collects its own app's `src/`).
- First line, exactly this marker (the clean step deletes only marked files):

```ts
// DOBERMAN-TEMPORARY: reproduction for <finding id>, deleted by `doberman.mjs clean`.
```

## Running and classifying

Paths are relative to the app (`apps/web` or `apps/api`):

```sh
pnpm --filter web exec vitest run --coverage=false src/<path>.doberman.spec.tsx > "<logDir>/repro-<id>.log" 2>&1; echo "DOBERMAN_EXIT=$?"
pnpm --filter api exec vitest run src/<path>.doberman.spec.ts > "<logDir>/repro-<id>.log" 2>&1; echo "DOBERMAN_EXIT=$?"
pnpm --filter api exec vitest run --config vitest.config.int.ts src/<path>.doberman.int.spec.ts > "<logDir>/repro-<id>.log" 2>&1; echo "DOBERMAN_EXIT=$?"
```

Integration specs need the database (the plan's `services`: `pnpm db:up`) and run on `<db>_test`.

| Status         | When                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| REPRODUCED     | the test fails **on the assertion that encodes the expected behavior**, with the wrong value the bug predicts (quote it as evidence)     |
| NOT REPRODUCED | the test passes: the code handles the scenario. Drop the finding, or keep it UNVERIFIED only if the test could not model the real timing |
| UNVERIFIABLE   | the scenario cannot be expressed here (a real browser across tabs, infrastructure only production has): say what would settle it         |

A failure for any other reason (import error, type error, missing database, a helper misused) is
not a reproduction: fix the test and run it again. Read the failing assertion before calling it
REPRODUCED.

## Web patterns

Shared setup, as the existing specs do (`apps/web/src/pages/AdminUsersPage.spec.tsx`):

```tsx
// DOBERMAN-TEMPORARY: reproduction for F1, deleted by `doberman.mjs clean`.
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetForTests, setSession } from '../auth/session';
import { admin, member } from '../test/fixtures';
import { deferred, failure, ok, stubFetch } from '../test/http';
import { renderRoute } from '../test/render';

beforeEach(() => {
  resetForTests();
  setSession({ accessToken: 'token-a', expiresIn: 900, user: member });
});
afterEach(() => {
  resetForTests();
});
```

`stubFetch({ 'METHOD /path': handler })` returns `{ fetchMock, calls }` (`calls` are the `Request`
objects, headers and signal included); routes match the exact path. `deferred<Response>()` holds a
response; `session(token, user)` is a sign-in or refresh answer; `setSessionHint()` makes `boot()`
try a refresh.

### Late response after sign-out or a user switch

Hold the page's request, sign out (`signOut()` with `POST /api/auth/logout` stubbed), sign in as
another user (`setSession(...)` with a different user), release the held response, and assert the
second user never sees the first user's data, and that no request was replayed with the first
user's token (`calls[n].headers.get('Authorization')`).

### Responses out of order

```tsx
const first = deferred<Response>();
const second = deferred<Response>();
const queue = [first, second];
stubFetch({ 'GET /api/things': () => (queue.shift() ?? first).promise });
// trigger two loads (a key change, a retry, a filter), then:
await act(async () => {
  second.resolve(ok(newest));
});
await act(async () => {
  first.resolve(ok(oldest));
});
expect(screen.queryByText(oldestLabel)).toBeNull();
```

### Concurrent 401s and the refresh

Two requests answered 401 at once must produce one `POST /api/auth/refresh` (the server rotates the
cookie): hold the refresh with `deferred()`, count
`calls.filter((r) => new URL(r.url).pathname === '/api/auth/refresh')`, then check both requests
were replayed once with the new token. `apps/web/src/auth/session.spec.ts` holds the reference
tests.

### Abort-aware responses

`deferred()` ignores the request's signal; a real `fetch` rejects with an `AbortError`. When the
finding is about cancellation:

```ts
function abortable(request: Request, response: Promise<Response>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (request.signal.aborted) abort();
    request.signal.addEventListener('abort', abort);
    response.then(resolve, reject);
  });
}
```

Then assert on `calls[n].signal.aborted` and on what the UI shows afterwards.

### Double submit

Hold the mutation with `deferred()`, click the submit button twice with
`userEvent.setup().click(...)`, and expect one `POST` in `calls`.

## API patterns

Integration setup, as `apps/api/src/users/users.int.spec.ts` does:

```ts
// DOBERMAN-TEMPORARY: reproduction for F2, deleted by `doberman.mjs clean`.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from '../../test/app.js';
import { asUser, bearer, seedUser, signIn } from '../../test/auth.js';
import { envelopeOf } from '../../test/http.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase(t.prisma);
});
afterAll(async () => {
  await t.app.close();
});
```

### Object-level access (IDOR)

Seed two members, call the route for the other one's record with `asUser(t.app, member.id)`, and
expect 404 with no data (`envelopeOf(res)`); repeat for update and delete routes. Anonymous → 401,
forbidden role → 403.

### Concurrent requests

`await Promise.all([request(t.server).post(...), request(t.server).post(...)])` for double
submissions, two refreshes with the same cookie (`signIn` returns the cookies), or two writers of
the same row; assert the documented outcome (one winner, idempotent replay, no duplicate row, the
family not revoked by a race inside the leeway).

### Validation and output

Send boundary inputs (too long, wrong type, extra fields, negative or huge `limit`) and expect
400 with the envelope; read the response body for fields that must never leave the API
(`passwordHash`, tokens, internal ids of other users).

### Unit level

When the database is not needed, construct the service with fakes as the unit specs do
(`new UsersService(fakePrisma)`), and drive the timing with `deferred()`-style promises or
`vi.useFakeTimers()` (restored at the end).

## Validating the fix (optional)

When the fix is small and certain, show the test is the right one: create the sandbox
(`doberman.mjs sandbox --run <runDir>`), install there (`HUSKY=0 pnpm install --frozen-lockfile
--offline`, without `--offline` if the store lacks packages), apply the fix and copy the
reproduction test into the sandbox, run it there: it must pass. Record that in `fixValidated`. The
workspace is never touched; the sandbox is deleted by the clean step. (Integration specs in the
sandbox need `DATABASE_URL` in the environment: the sandbox has no `.env`.)

## What cannot be reproduced here

Real multi-tab behavior (Web Locks and BroadcastChannel across real tabs), real proxies and TLS,
the production Redis and its failover, load and timing at scale (docs/load-testing.md), and the
deployed nginx in front of the API. Mark those UNVERIFIABLE with what would settle them (an E2E
spec, a load test, a staging check).

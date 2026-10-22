# Error handling

One shape, one place per side, no leaks.

## API

Every error leaves as `{ "data": null, "message": "..." }` with its HTTP status, produced by
`AllExceptionsFilter` (`apps/api/src/common/filters/all-exceptions.filter.ts`):

| Thrown                                                | Status     | Message sent                                   |
| ----------------------------------------------------- | ---------- | ---------------------------------------------- |
| `HttpException` (`NotFoundException`, ...)            | its status | its message                                    |
| Zod validation failure (`ZodValidationPipe`)          | 400        | every issue with its path                      |
| Malformed JSON body                                   | 400        | `The request body is not valid JSON`           |
| Body too large (the parser's limit)                   | 413        | the parser's safe message                      |
| Rate limit (`ThrottlerException`)                     | 429        | `Too many requests, retry later`               |
| Prisma `P2002` unique violation                       | 409        | generic, no column names                       |
| Prisma `P2003` foreign key                            | 409        | generic                                        |
| Prisma `P2025` record not found                       | 404        | `Record not found`                             |
| `ExternalServiceError` (external HTTP client)         | 502 / 504  | generic: an upstream failed or timed out       |
| `RedisUnavailableError` (a feature that fails closed) | 503        | `Service temporarily unavailable, retry later` |
| Anything else                                         | 500        | `An unexpected error occurred`                 |

Rules:

- **Throw, do not return errors.** Services throw Nest exceptions with a message written for the
  client developer (English, no internals).
- **Never leak internals.** Stack traces, SQL, file paths, library messages and secrets stay in
  the log. A 5xx is logged with method, path (no query string), status and the request id the
  client received in `X-Request-Id`; 4xx are expected and not logged as errors. A Prisma error's
  message is neither logged nor reported (it can quote the query's arguments: an address, a
  name): its class, code and frames are (`loggableStack`, `reportableError` in
  `common/logging/error-summary.ts`).
- **404 over 403 for records the caller may not see** (docs/security.md#authorization).
- **Fail fast at boot on configuration.** A missing or invalid environment variable stops the
  process with the variable's name (docs/environment.md). A database that is down does not: the API
  starts, its readiness answers 503 until the database is back, and liveness stays 200, so the
  orchestrator holds traffic back without restarting it in a loop.
- **Non-JSON bodies** are refused with 415 before any parsing (`common/http/json-only.middleware.ts`).
- **Session cookies follow the answer:** a refresh that fails with 401 clears them; one that fails
  on the server side (5xx) keeps them, since the session may be fine; logout clears them even when
  it fails.
- **Errors outside a request** (an uncaught exception, an unhandled rejection) are logged at
  `fatal` and stop the process, which the orchestrator restarts (docs/observability.md).

## Web

- **API calls:** `call(api.GET(...))` turns every outcome into
  `{ ok: true, data } | { ok: false, failure: { status, message, retryAfterSec? } }`
  (`apps/web/src/api/errors.ts`). Network failures and timeouts are `status: 0`. A success answer
  without the `{ data, message }` envelope (other than a bodyless `204`) did not come from the API
  (a proxy, a captive portal): it fails with `status: 502`, never reaching a screen as data.
  Screens switch on `ok`; there is no try/catch around API calls.
- **User-facing text:** a screen maps the statuses it expects (sign-in maps 401 to "Invalid email or
  password."); everything else goes through `describeFailure(failure)`. The server `message` is for
  developers and logs, never shown as is.
- **Loading and retry:** `useLoader(fetcher)` gives `loading | loaded | failed` and a `retry()`;
  `LoadFailed` renders the message and a retry button.
- **Session errors:** a 401 to a request that carried a token triggers one refresh and one replay;
  a second 401 signs the user out (`src/auth/middleware.ts`). A refresh that fails on the server
  side or on the network, or gets no answer within 10 seconds (it holds the cross-tab lock
  meanwhile), keeps the session for the next attempt. A sign-out the server could not
  confirm is shown on the sign-in page with a retry.
- **Render errors:** the root route's `errorElement` (`RouteErrorPage`) catches anything thrown
  while rendering, logs it with `console.error` (the hook for an error tracker, docs/observability.md)
  and offers a way home.
- **Forms:** `noValidate`, client checks for quick feedback (`src/auth/validation.ts`), inline
  messages tied to the field with `aria-describedby`, the server's answer is final.

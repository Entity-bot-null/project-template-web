# API conventions

REST over JSON, everything under `/api`. The contract is `openapi/openapi.json`
(see [openapi/README.md](../openapi/README.md) for the contract-first workflow).

## Shape of every response

```json
{ "data": <payload or null>, "message": "Operation successful" }
```

- Controllers return plain values; `TransformInterceptor` wraps them. Return `{ data, message }`
  yourself only to choose the message (`'Signed in'`).
- Errors use the same envelope with `data: null` and the HTTP status (docs/error-handling.md).
- `204 No Content` has no body.
- Every response carries `X-Request-Id`; quote it in bug reports.
- Every response carries `Cache-Control: no-store` (`app.setup.ts`): responses hold tokens and
  personal data. A route whose answer is public and the same for everyone may set its own caching
  header, in review.

## Routes

| Rule                       | Example                                                                         |
| -------------------------- | ------------------------------------------------------------------------------- |
| Plural nouns, kebab-case   | `/api/users`, `/api/password-resets`                                            |
| Nest by ownership only     | `/api/projects/:projectId/tasks` (not deeper than one level)                    |
| Actions as sub-resources   | `POST /api/auth/sign-in`, `POST /api/invitations/:id/accept`                    |
| ids are UUIDs              | `@Param('id', ParseUUIDPipe)`; params named `id`/`…Id` are documented as `uuid` |
| `camelCase` JSON fields    | `createdAt`, `accessToken`                                                      |
| Timestamps in ISO 8601 UTC | `2026-01-31T12:00:00.000Z`                                                      |

## Methods and status codes

| Method   | Use                            | Success                                                                                      |
| -------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `GET`    | read, never changes state      | `200`                                                                                        |
| `POST`   | create, or run an action       | `201` (create), `200` (action), `204` (an action with nothing to return: logout, Web Vitals) |
| `PATCH`  | partial update                 | `200` with the updated record                                                                |
| `PUT`    | full replacement (rarely used) | `200`                                                                                        |
| `DELETE` | delete, idempotent             | `204`                                                                                        |

Errors: `400` validation, `401` not authenticated, `403` authenticated but not allowed, `404` not
found (also for records the caller may not see), `409` conflict, `413` body too large, `429` rate
limit (with `Retry-After`), `503` a dependency is down. Document each route's errors with
`@ApiErrors(...)`; `@Auth()` documents 401/403 itself.

## Validation

- Bodies: `@ZodBody(Schema)` with a bare `@Body()`. Queries: `@ZodQuery(z.object(...))` with a
  bare `@Query()`; numeric query fields use `z.coerce.number()`.
- Unknown keys are stripped, defaults applied; the handler receives the parsed value.
- Bound everything: string `max`, array `max`, numeric ranges. The request body limit is 100 kB
  (Express default) unless a route needs more.
- Bodies are JSON only (`Content-Type: application/json`); anything else answers 415. A route that
  must take another type (a file upload) is exempted explicitly in
  `common/http/json-only.middleware.ts`, in review.
- The message lists every problem with its path: `email: Invalid email address, password: ...`.

## Responses (output validation)

- Response shapes are Zod schemas in `dto/*.schemas.ts`, documented with `@ApiData(Schema)`.
- Select columns explicitly (`USER_SELECT`): a new database column stays private until added to
  the select and the schema. Never return a whole Prisma model.

## Pagination

List routes take `limit` (1 to 100, default 20) and `offset` (default 0) through `PageQuerySchema`
and answer `{ items, total }` (`pageOf(ItemSchema)`). Order by a unique key last so pages never
overlap (`orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]`). For very large or fast-moving
collections, switch that route to cursor pagination (OPCIONAL).

## Authentication and authorization

Every route is protected with `@Auth()` (any signed-in user) or `@Auth('admin', ...)` unless it is
deliberately public (sign-in, health). Object-level checks live in the service: see
docs/security.md#authorization. Every route, public ones included, also passes the global CSRF
guard: a browser request made by a page on another origin is refused unless that origin is in
`CORS_ORIGINS` (docs/security.md#csrf-cors-xss).

## Versioning and compatibility

The web app ships with the API, so the contract evolves in place. Changes that break an existing
client (removing or renaming a field, a new required input, a changed status) need: a contract
review, the client updated in the same pull request, and, for external clients, a deprecation
period or a new path version (`/api/v2/...`). Additive changes (new optional fields, new routes) are
always safe.

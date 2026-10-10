# API contract

`openapi.json` is the contract between the API and every client. It is generated, committed, and
reviewed like code: a pull request that changes the API shows the change here, in one diff.

```
Zod schemas + controller decorators (apps/api)
        │  pnpm contract
        ▼
openapi/openapi.json            ← reviewed in the pull request
        │  (same command)
        ▼
apps/web/src/api/schema.d.ts    ← generated types
        │
        ▼
apps/web/src/api/client.ts      ← the one typed client (openapi-fetch)
        │
        ▼
screens call api.GET('/api/users', …), fully typed
```

## Contract-first workflow

1. **Design the change first.** Write or edit the Zod schemas (`dto/*.schemas.ts`) and the
   controller signatures with their decorators (`@ZodBody`, `@ZodQuery`, `@ApiData`,
   `@ApiErrors`, `@Auth`). A handler may `throw new NotImplementedException()` at this stage.
2. **Generate:** `pnpm contract` at the repository root. It exports `openapi/openapi.json` from the
   code and regenerates `apps/web/src/api/schema.d.ts` from it.
3. **Review the contract.** Open the pull request (or a draft) with the contract diff before or
   alongside the implementation. Reviewers check names, status codes, required fields, pagination
   and authorization (docs/api-conventions.md).
4. **Implement both sides** against the typed contract. The compiler flags every client call that
   no longer matches.
5. **Commit both generated files.** Never edit them by hand.

## Drift gates

| Gate                                     | Fails when                                                 | Runs in                         |
| ---------------------------------------- | ---------------------------------------------------------- | ------------------------------- |
| `apps/api/src/openapi/openapi.spec.ts`   | the code produces a document different from `openapi.json` | `pnpm test` (pre-push, CI)      |
| `apps/web/scripts/api-types.mjs --check` | `schema.d.ts` differs from what `openapi.json` generates   | `pnpm typecheck` (pre-push, CI) |

Fix either by running `pnpm contract` and committing the result.

## Why the document is generated from code

The request schemas that validate input at runtime are the same objects that produce the
contract, so validation and documentation cannot disagree. Writing the YAML by hand and generating
server code from it is the alternative (OPCIONAL: tools such as openapi-typescript for the types
plus a request validator); it adds a second source of truth to keep in sync with NestJS, which is
why the template does not do it.

## Browsing it

`pnpm dev`, then http://localhost:3000/api/docs (Swagger UI, development only; never mounted in
production). Any OpenAPI 3.0 viewer or client generator can read `openapi.json` directly.

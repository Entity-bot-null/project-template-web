# How-to recipes

Step-by-step instructions for the changes you will make most often. The main recipes were
validated by building a complete example feature with them (a `notes` table, its API module,
contract, screen, unit, integration, component and E2E tests) and running every gate on it. The code
below is that example: copy it and rename.

When something fails along the way, see [troubleshooting.md](troubleshooting.md).

- [Add a table or a column](#add-a-table-or-a-column)
- [Add an API module (a new resource)](#add-an-api-module)
- [Add an endpoint to an existing module](#add-an-endpoint-to-an-existing-module)
- [Change the API contract](#change-the-api-contract)
- [Add a screen to the web app](#add-a-screen-to-the-web-app)
- [Add an end-to-end test](#add-an-end-to-end-test)
- [Add an environment variable](#add-an-environment-variable)
- [Add a role](#add-a-role)
- [Add a dependency](#add-a-dependency)
- [Cache a read](#cache-a-read)
- [Call an external service](#call-an-external-service)
- [Run a job on one instance, or process a message once](#run-a-job-on-one-instance-or-process-a-message-once)
- [Turn on Redis](#turn-on-redis)
- [Turn on error tracking](#turn-on-error-tracking)
- [Turn on tracing and metrics](#turn-on-tracing-and-metrics)
- [Pull changes from the team](#pull-changes-from-the-team)
- [Raise coverage thresholds or the performance budget](#raise-coverage-thresholds-or-the-performance-budget)
- [Add another app or a background worker](#add-another-app-or-a-background-worker)

Operations: rotate the token secret ([security.md](security.md#secret-rotation)), allow a client
on another origin ([security.md](security.md#csrf-cors-xss)), deploy and roll back
([ci-cd.md](ci-cd.md#deployment)).

---

## Add a table or a column

1. Edit `apps/api/prisma/schema.prisma` following [database.md](database.md#conventions): UUIDv7
   key, `Timestamptz(3)` dates, snake_case names, an index for every foreign key and for the
   queries you will run, a deliberate `onDelete`.

   ```prisma
   model User {
     // ... existing fields
     notes Note[]
   }

   // A short text that belongs to one user.
   model Note {
     id        String   @id @default(uuid(7)) @db.Uuid
     ownerId   String   @map("owner_id") @db.Uuid
     title     String
     body      String   @default("")
     createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
     updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

     owner User @relation(fields: [ownerId], references: [id], onDelete: Cascade)

     // Serves "the notes of one owner, newest first".
     @@index([ownerId, createdAt])
     @@map("notes")
   }
   ```

2. Create and apply the migration, and regenerate the client, in one command (database running:
   `pnpm db:up`):

   ```
   pnpm db:migrate --name add_notes
   ```

   Without `--name` it asks for one. Use snake_case names that say what changes.

3. Review `apps/api/prisma/migrations/<timestamp>_add_notes/migration.sql`: locks on big tables,
   defaults, `DROP` statements. A column that existing rows cannot fill needs a default or the
   [expand/contract](database.md#expand-and-contract) steps.
4. Commit the schema and the migration folder together with the code that uses them. Never edit a
   migration that is already on `main`.
5. If the development accounts need data in the new table, extend `apps/api/src/seed/seed.ts`
   (idempotent: upsert on a unique key).

## Add an API module

A module is a folder in `apps/api/src/<name>/` with its schemas, service, controller, module and
tests. `users/` is the reference.

**1. Schemas** (`dto/note.schemas.ts`): input and output shapes, the single source for validation,
the contract and the types.

```ts
import { z } from 'zod';
import { pageOf } from '../../common/pagination.js';

// What the API answers about a note (output).
export const NoteSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type NoteResponse = z.infer<typeof NoteSchema>;

export const NotePageSchema = pageOf(NoteSchema);

// What a client may send (input): trimmed, bounded, defaults applied.
export const CreateNoteSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10_000).default(''),
});
export type CreateNoteDto = z.infer<typeof CreateNoteSchema>;

// Every query selects exactly the documented fields.
export const NOTE_SELECT = {
  id: true,
  title: true,
  body: true,
  createdAt: true,
  updatedAt: true,
} as const;
```

**2. Service** (`notes.service.ts`): the rules and the queries. Ownership goes **in the query**.

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import type { PageQuery } from '../common/pagination.js';
import type { RequestUser } from '../common/types/request-user.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type CreateNoteDto, NOTE_SELECT } from './dto/note.schemas.js';

@Injectable()
export class NotesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(owner: RequestUser, { limit, offset }: PageQuery) {
    const where = { ownerId: owner.id };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.note.findMany({
        where,
        select: NOTE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.note.count({ where }),
    ]);
    return { items, total };
  }

  create(owner: RequestUser, data: CreateNoteDto) {
    return this.prisma.note.create({ data: { ...data, ownerId: owner.id }, select: NOTE_SELECT });
  }

  // Ownership lives in the query: another user's note is "not found",
  // exactly like a missing one.
  async findOwned(owner: RequestUser, id: string) {
    const note = await this.prisma.note.findFirst({
      where: { id, ownerId: owner.id },
      select: NOTE_SELECT,
    });
    if (!note) throw new NotFoundException('Note not found');
    return note;
  }

  async remove(owner: RequestUser, id: string): Promise<void> {
    const { count } = await this.prisma.note.deleteMany({ where: { id, ownerId: owner.id } });
    if (count === 0) throw new NotFoundException('Note not found');
  }
}
```

**3. Controller** (`notes.controller.ts`): thin. Parse (decorators), authorize (`@Auth`), delegate.

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/auth.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ApiData, ApiErrors, ZodBody, ZodQuery } from '../common/openapi/index.js';
import { type PageQuery, PageQuerySchema } from '../common/pagination.js';
import type { RequestUser } from '../common/types/request-user.js';
import {
  type CreateNoteDto,
  CreateNoteSchema,
  NotePageSchema,
  NoteSchema,
} from './dto/note.schemas.js';
import { NotesService } from './notes.service.js';

// Every route needs a signed-in user; each one sees only their own notes.
@ApiTags('notes')
@Controller('notes')
@Auth()
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  @ApiOperation({ summary: "The caller's notes, newest first" })
  @ZodQuery(PageQuerySchema)
  @ApiData(NotePageSchema)
  @ApiErrors(400)
  list(@CurrentUser() owner: RequestUser, @Query() query: PageQuery) {
    return this.notes.list(owner, query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a note' })
  @ZodBody(CreateNoteSchema)
  @ApiData(NoteSchema, { status: 201 })
  @ApiErrors(400)
  create(@CurrentUser() owner: RequestUser, @Body() body: CreateNoteDto) {
    return this.notes.create(owner, body);
  }

  @Get(':id')
  @ApiOperation({ summary: "One of the caller's notes" })
  @ApiData(NoteSchema)
  @ApiErrors(400, 404)
  findOne(@CurrentUser() owner: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notes.findOwned(owner, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: "Delete one of the caller's notes" })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiErrors(400, 404)
  async remove(
    @CurrentUser() owner: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.notes.remove(owner, id);
  }
}
```

Admin-only routes: `@Auth('admin')` on the handler or the controller. Public routes (rare):
leave `@Auth()` out and say why in a comment.

**4. Module** (`notes.module.ts`), then add `NotesModule` to the `imports` of
`apps/api/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

@Module({
  // @Auth() needs the JwtModule that AuthModule exports.
  imports: [AuthModule],
  controllers: [NotesController],
  providers: [NotesService],
})
export class NotesModule {}
```

**5. Contract:** `pnpm contract`, then review the diff of `openapi/openapi.json`. Until you run
it, `pnpm test` fails with `matches the committed openapi/openapi.json (run pnpm contract when
this fails)`: that is the drift gate doing its job.

**6. Unit tests** (`notes.service.spec.ts`): the service with Prisma faked, one test per rule.
Cover **every** service method: unit coverage counts services, guards and utilities, and the
coverage gate fails if new code lowers it (controllers and modules are left to the integration
suite).

```ts
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../common/types/request-user.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { NotesService } from './notes.service.js';

const OWNER: RequestUser = { id: '0190b6a1-0000-7000-8000-000000000001', role: 'member' };
const NOTE_ID = '0190b6a1-0000-7000-8000-0000000000aa';

// Prisma faked at the method level: the specs check which query the service
// builds (who may match), the integration spec checks the real database.
function setup({ found = null, deleted = 0 }: { found?: unknown; deleted?: number } = {}) {
  const note = {
    findMany: vi.fn().mockReturnValue('findMany-query'),
    count: vi.fn().mockReturnValue('count-query'),
    create: vi.fn().mockResolvedValue({ id: NOTE_ID }),
    findFirst: vi.fn().mockResolvedValue(found),
    deleteMany: vi.fn().mockResolvedValue({ count: deleted }),
  };
  const $transaction = vi.fn().mockResolvedValue([[{ id: NOTE_ID }], 1]);
  const service = new NotesService({ note, $transaction } as unknown as PrismaService);
  return { service, note };
}

describe('NotesService', () => {
  it("lists only the caller's notes, one bounded page in a stable order", async () => {
    const { service, note } = setup();
    await expect(service.list(OWNER, { limit: 10, offset: 20 })).resolves.toEqual({
      items: [{ id: NOTE_ID }],
      total: 1,
    });
    expect(note.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: OWNER.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
        skip: 20,
      }),
    );
    expect(note.count).toHaveBeenCalledWith({ where: { ownerId: OWNER.id } });
  });

  it('creates the note for the caller, whatever the body says', async () => {
    const { service, note } = setup();
    await service.create(OWNER, { title: 'Groceries', body: '' });
    expect(note.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { title: 'Groceries', body: '', ownerId: OWNER.id } }),
    );
  });

  it('looks a note up by id AND owner, so other owners never match', async () => {
    const { service, note } = setup({ found: { id: NOTE_ID } });
    await service.findOwned(OWNER, NOTE_ID);
    expect(note.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: NOTE_ID, ownerId: OWNER.id } }),
    );
  });

  it('answers 404 when the note is missing or belongs to someone else', async () => {
    await expect(setup().service.findOwned(OWNER, NOTE_ID)).rejects.toThrow(NotFoundException);
  });

  it("deletes only the caller's note and answers 404 otherwise", async () => {
    const { service, note } = setup({ deleted: 1 });
    await service.remove(OWNER, NOTE_ID);
    expect(note.deleteMany).toHaveBeenCalledWith({ where: { id: NOTE_ID, ownerId: OWNER.id } });
    await expect(setup({ deleted: 0 }).service.remove(OWNER, NOTE_ID)).rejects.toThrow(
      'Note not found',
    );
  });
});
```

**7. Integration tests** (`notes.int.spec.ts`): the real app and database. For every protected
resource test: anonymous (401), the owner, **another user (404)**, invalid input (400). A route on
one record gets the access matrix, `expectRecordAccess` ([authorization.md](authorization.md#tests)).

```ts
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectRecordAccess } from '../../test/access.js';
import { createTestApp, resetDatabase, type TestApp } from '../../test/app.js';
import { asUser, seedUser } from '../../test/auth.js';
import { envelopeOf } from '../../test/http.js';
import type { NoteResponse } from './dto/note.schemas.js';

describe('Notes (integration)', () => {
  let t: TestApp;
  let alice: { id: string };
  let bob: { id: string };

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    alice = await seedUser(t.prisma, { email: 'alice@example.com' });
    bob = await seedUser(t.prisma, { email: 'bob@example.com' });
  });

  afterAll(async () => {
    await t.app.close();
  });

  const asAlice = () => asUser(t.app, alice.id);
  const asBob = () => asUser(t.app, bob.id);

  it('needs a signed-in user', async () => {
    await request(t.server).get('/api/notes').expect(401);
  });

  it('creates a note and lists it for its owner only', async () => {
    const created = envelopeOf<NoteResponse>(
      await request(t.server)
        .post('/api/notes')
        .set(asAlice())
        .send({ title: '  Groceries ' })
        .expect(201),
    ).data;
    expect(created).toMatchObject({ title: 'Groceries', body: '' });

    const mine = envelopeOf<{ items: NoteResponse[]; total: number }>(
      await request(t.server).get('/api/notes').set(asAlice()).expect(200),
    ).data;
    expect(mine.items.map((note) => note.id)).toEqual([created.id]);

    const theirs = envelopeOf<{ total: number }>(
      await request(t.server).get('/api/notes').set(asBob()).expect(200),
    ).data;
    expect(theirs.total).toBe(0);
  });

  it('lets only the owner read or delete a note; to anyone else it does not exist', async () => {
    const note = await t.prisma.note.create({ data: { ownerId: alice.id, title: 'Private' } });
    const route = { path: (id: string) => `/api/notes/${id}`, id: note.id };
    await expectRecordAccess(t.server, { ...route, owner: asAlice(), other: asBob() });
    await expectRecordAccess(t.server, {
      ...route,
      method: 'delete',
      owner: asAlice(),
      other: asBob(),
      status: 204,
    });
    await request(t.server).get(`/api/notes/${note.id}`).set(asAlice()).expect(404);
  });

  it('validates the body', async () => {
    const res = await request(t.server)
      .post('/api/notes')
      .set(asAlice())
      .send({ title: '' })
      .expect(400);
    expect(envelopeOf(res).message).toMatch(/^title: /);
  });
});
```

**8. Check:** `pnpm verify` and `pnpm test:integration`.

## Add an endpoint to an existing module

1. Add the input/output Zod schemas to the module's `dto/` (or reuse existing ones).
2. Add the service method (rules, ownership in the query) and its unit test.
3. Add the handler: route decorator, `@ZodBody`/`@ZodQuery`, `@ApiData`, `@ApiErrors`, and
   `@Auth(...)` if it differs from the controller's.
4. `pnpm contract`, review the contract diff.
5. Integration tests for the new route: allowed, forbidden, other user's record, invalid input.

## Change the API contract

The contract changes whenever a controller or a schema in `dto/` changes. Always:
`pnpm contract`, then commit `openapi/openapi.json` and `apps/web/src/api/schema.d.ts` in the
same pull request as the code, and point reviewers to the contract diff.

- **Safe (additive):** a new route, a new optional input field, a new output field.
- **Breaking:** removing or renaming a field or route, a new required input, a changed type or
  status code. The web app compiles against the generated types, so `pnpm typecheck` shows every
  call that breaks: fix them in the same pull request. External clients need a deprecation period
  or a new versioned path ([api-conventions.md](api-conventions.md#versioning-and-compatibility)).

## Add a screen to the web app

1. **Page** in `apps/web/src/pages/` (here `NotesPage.tsx`): data through `api` + `call()`,
   loading and retry through `useLoader`, user messages through `describeFailure`.

   ```tsx
   import { useState } from 'react';
   import { api } from '../api/client';
   import { call, describeFailure } from '../api/errors';
   import { Alert } from '../components/Alert';
   import { LoadFailed } from '../components/LoadFailed';
   import { useLoader } from '../hooks/useLoader';

   const fetchNotes = () => call(api.GET('/api/notes', { params: { query: { limit: 50 } } }));

   export function NotesPage() {
     // Bumping the version reloads the list after a change.
     const [version, setVersion] = useState(0);
     const { state, retry } = useLoader(fetchNotes, version);
     const [title, setTitle] = useState('');
     const [failure, setFailure] = useState<string | null>(null);
     const [saving, setSaving] = useState(false);

     async function create() {
       if (title.trim().length === 0) {
         setFailure('Write a title.');
         return;
       }
       setSaving(true);
       const result = await call(api.POST('/api/notes', { body: { title } }));
       setSaving(false);
       if (!result.ok) {
         setFailure(describeFailure(result.failure));
         return;
       }
       setFailure(null);
       setTitle('');
       setVersion((current) => current + 1);
     }

     return (
       <section className="stack" aria-labelledby="notes-heading">
         <h1 id="notes-heading">Notes</h1>
         <form
           className="stack"
           noValidate
           onSubmit={(event) => {
             event.preventDefault();
             void create();
           }}
         >
           {failure !== null && <Alert>{failure}</Alert>}
           <div className="field">
             <label htmlFor="note-title">Title</label>
             <input
               id="note-title"
               value={title}
               maxLength={200}
               onChange={(event) => {
                 setTitle(event.target.value);
               }}
             />
           </div>
           <button type="submit" disabled={saving}>
             {saving ? 'Saving…' : 'Add note'}
           </button>
         </form>
         {state.kind === 'loading' && <p role="status">Loading notes…</p>}
         {state.kind === 'failed' && (
           <LoadFailed
             failure={state.failure}
             retrying={state.retrying}
             onRetry={() => void retry()}
           />
         )}
         {state.kind === 'loaded' &&
           (state.data.items.length === 0 ? (
             <p>No notes yet.</p>
           ) : (
             <ul>
               {state.data.items.map((note) => (
                 <li key={note.id}>{note.title}</li>
               ))}
             </ul>
           ))}
       </section>
     );
   }
   ```

2. **Route** in `apps/web/src/router.tsx`, under the guard it needs (`RequireAuth`, or
   `RequireRole role="admin"`): `<Route path="notes" element={<NotesPage />} />`.
3. **Navigation** in `apps/web/src/components/AppLayout.tsx`: `<NavLink to="/notes">Notes</NavLink>`
   (wrap it in a role check if only some roles may see it; the API enforces access anyway).
4. **Component test** (`NotesPage.spec.tsx`): the real route tree with `fetch` mocked. Test the
   happy path **and** the failure paths (the coverage gate counts them).

   ```tsx
   import { screen } from '@testing-library/react';
   import userEvent from '@testing-library/user-event';
   import { afterEach, beforeEach, describe, expect, it } from 'vitest';
   import { resetForTests, setSession } from '../auth/session';
   import { member } from '../test/fixtures';
   import { failure, json, ok, stubFetch } from '../test/http';
   import { renderRoute } from '../test/render';

   const note = (id: string, title: string) => ({
     id,
     title,
     body: '',
     createdAt: '2026-01-01T00:00:00.000Z',
     updatedAt: '2026-01-01T00:00:00.000Z',
   });

   beforeEach(() => {
     resetForTests();
     setSession({ accessToken: 'token', expiresIn: 900, user: member });
   });
   afterEach(() => {
     resetForTests();
   });

   describe('NotesPage', () => {
     it('lists the notes and adds one', async () => {
       let items = [note('n1', 'First')];
       const sent: unknown[] = [];
       stubFetch({
         'GET /api/notes': () => ok({ items, total: items.length }),
         'POST /api/notes': async (request) => {
           const body = (await request.json()) as { title: string };
           sent.push(body);
           items = [note('n2', body.title), ...items];
           return json(201, { data: items[0], message: 'Operation successful' });
         },
       });
       renderRoute('/notes');
       expect(await screen.findByText('First')).toBeInTheDocument();

       const user = userEvent.setup();
       await user.type(screen.getByLabelText('Title'), 'Second');
       await user.click(screen.getByRole('button', { name: 'Add note' }));

       expect(await screen.findByText('Second')).toBeInTheDocument();
       expect(sent).toEqual([{ title: 'Second' }]);
       expect(screen.getByLabelText('Title')).toHaveValue('');
     });

     it('explains a failed save and keeps what was typed', async () => {
       stubFetch({
         'GET /api/notes': () => ok({ items: [], total: 0 }),
         'POST /api/notes': () => failure(503, 'Database unreachable'),
       });
       renderRoute('/notes');
       expect(await screen.findByText('No notes yet.')).toBeInTheDocument();

       const user = userEvent.setup();
       await user.type(screen.getByLabelText('Title'), 'Draft');
       await user.click(screen.getByRole('button', { name: 'Add note' }));

       expect(await screen.findByRole('alert')).toHaveTextContent('The service is unavailable');
       expect(screen.getByLabelText('Title')).toHaveValue('Draft');
     });

     it('asks for a title before calling the API', async () => {
       const { fetchMock } = stubFetch({ 'GET /api/notes': () => ok({ items: [], total: 0 }) });
       renderRoute('/notes');
       expect(await screen.findByText('No notes yet.')).toBeInTheDocument();
       await userEvent.setup().click(screen.getByRole('button', { name: 'Add note' }));
       expect(screen.getByRole('alert')).toHaveTextContent('Write a title.');
       expect(fetchMock).toHaveBeenCalledTimes(1);
     });
   });
   ```

5. **Check:** `pnpm verify`.

## Add an end-to-end test

E2E tests cover critical user flows only (sign-in, the main thing users come for, payments…);
everything else is cheaper as component or integration tests. Add a file in `e2e/` ending in
`.e2e.ts`; the development accounts from the seed are available.

```ts
import { expect, test } from '@playwright/test';

test('a member adds a note and finds it again after a reload', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('member@example.com');
  await page.getByLabel('Password').fill('member-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('link', { name: 'Notes' }).click();
  await page.getByLabel('Title').fill('Buy milk');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Buy milk' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: 'Buy milk' })).toBeVisible();
});
```

Run: `pnpm build && pnpm test:e2e` (database up). The suite reseeds `<db>_e2e` on every run, so
tests may create data freely; keep them independent of each other.

## Add an environment variable

1. Declare it in `apps/api/src/env/env.schema.ts` with its type, default and rules, and a comment
   saying what it is for:

   ```ts
   // Notes one user may keep (protects the database from a single account).
   NOTES_MAX_PER_USER: z.coerce.number().int().positive().default(1000),
   ```

   Numbers and booleans arrive as strings: use `z.coerce.number()` or
   `z.enum(['true', 'false']).transform((v) => v === 'true')`. A value required only in
   production: make it optional and add the check in `superRefine` (see `AUTH_COOKIE_SAMESITE`).

2. Use it through the validated module: `import { env } from '../env/env.js'` then
   `env.NOTES_MAX_PER_USER`. Reading `process.env` is a lint error.
3. Add it to `apps/api/.env.example` (commented out when it has a default) with one line of
   explanation, and to the table in [environment.md](environment.md).
4. Test the rules in `apps/api/src/env/env.schema.spec.ts` (default, and one invalid value). If
   the test suites need a fixed value, set it in `test.env` of `apps/api/vitest.config.ts` or
   `vitest.config.int.ts`.
5. Deployment: add it to the staging and production configuration (secrets in the GitHub
   environment or the platform's secret store, never in a committed file). A new **required**
   variable stops the API at boot until it is set: deploy the configuration first.

The web app's deployment settings are set on the web container and served as `/app-config.json`
(docs/environment.md#web-variables); a `VITE_*` variable is public (compiled into the bundle).

## Add a role

1. Add the value to `enum Role` in `apps/api/prisma/schema.prisma` and to `ROLES` in
   `apps/api/src/common/types/request-user.ts`, in the same order, least to most privileged (a
   unit spec fails when they differ).
2. `pnpm db:migrate --name add_<role>_role`.
3. Use it: `@Auth('admin', '<role>')` on the routes it may call, ownership rules in the services,
   `<RequireRole role={['admin', '<role>']} />` for its screens.
4. `pnpm contract` (the role appears in the contract; the web `Role` type follows).
5. Integration tests for what the role may and may not do; optionally a development account in the
   seed.

## Add a dependency

1. Add it to the app that uses it, never to the root unless it is repository tooling:

   ```
   pnpm --filter api add <package>
   pnpm --filter web add -D <package>
   pnpm add -D -w <package>          # repository tooling only
   ```

2. Justify it in the pull request: maintained, license, size (the web bundle budget will tell),
   no simpler alternative. `pnpm deps:check` fails on a license outside
   `scripts/dependency-policy.json` (production dependencies need a permissive one) and on a
   package from a git repository or a URL instead of the registry
   ([security.md](security.md#dependency-policy)).
3. **Install scripts:** if the package runs one, pnpm stops with `ERR_PNPM_IGNORED_BUILDS` and adds
   it to `allowBuilds` in `pnpm-workspace.yaml` with a placeholder. Set `true` only when the script
   is needed (native binaries), otherwise `false`, with a comment saying why.
4. **Brand-new versions:** a version published less than seven days ago is refused
   (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`). Wait, or, for an urgent security fix only, exempt
   that exact version in `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, with its expiry date
   and the advisory (`- 'name@1.2.3' # expires YYYY-MM-DD: GHSA-...`, at most seven days ahead;
   [security.md](security.md#dependency-vulnerabilities)). `pnpm deps:check` fails once it expires.
   A package whose own dependencies come from a git repository or a tarball URL is refused too
   (`blockExoticSubdeps`), and so is a recent version published with weaker evidence than its
   predecessors (`High-risk trust downgrade`, `trustPolicy`): pick another version, and report it
   upstream if it looks like a takeover.
5. `pnpm security` (no high or critical advisories, dependency policy) and `pnpm verify`. Commit `package.json`,
   `pnpm-lock.yaml` and, if it changed, `pnpm-workspace.yaml`.

## Cache a read

Only for reads that are expensive, frequent and allowed to be up to a TTL old; read the "never
cache" list first ([architecture.md](architecture.md#cache)).

```ts
import { Injectable } from '@nestjs/common';
import { CacheService, type NamespacedCache } from '../infrastructure/cache/cache.service.js';

@Injectable()
export class ReportsService {
  private readonly summaries: NamespacedCache<Summary>;

  constructor(
    cache: CacheService,
    private readonly prisma: PrismaService,
  ) {
    // One namespace per kind of value, declared once (in the constructor:
    // a field initializer would run before `cache` is assigned).
    this.summaries = cache.namespace<Summary>('report-summaries', { ttlSec: 300 });
  }

  summary(ownerId: string): Promise<Summary> {
    // The owner is part of the key: entries never cross users.
    return this.summaries.getOrSet(ownerId, () => this.computeSummary(ownerId));
  }

  async addEntry(ownerId: string, data: EntryInput): Promise<void> {
    await this.prisma.entry.create({ data: { ...data, ownerId } });
    await this.summaries.delete(ownerId); // in the same code path as the change
  }
}
```

`CacheService` is global: no module import needed. Unit specs pass a `MemoryCacheStore`
(`new CacheService(new MemoryCacheStore(), redisKeys)`, see `cache.service.spec.ts`). With several
instances set `CACHE_STORE=redis`, or keep TTLs short: a memory cache is per instance.

## Call an external service

Through the shared client, never a bare `fetch` (docs/observability.md#external-services):

1. Its settings in the env schema (`BILLING_URL`, `BILLING_API_KEY`), `.env.example` and
   docs/environment.md ([Add an environment variable](#add-an-environment-variable)). The base URL
   comes from configuration, never from user input.
2. A small service that owns the client:

   ```ts
   import { Injectable } from '@nestjs/common';
   import { createExternalHttpClient } from '../common/http/external-http.js';
   import { env } from '../env/env.js';

   @Injectable()
   export class BillingClient {
     private readonly http = createExternalHttpClient({
       name: 'billing', // metric attribute, log field, error report tag
       baseUrl: env.BILLING_URL,
       timeoutMs: 3_000,
       headers: () => ({ Authorization: `Bearer ${env.BILLING_API_KEY}` }), // never logged
     });

     async invoice(id: string): Promise<Invoice> {
       const { body } = await this.http.request<Invoice>({
         path: `invoices/${encodeURIComponent(id)}`,
       });
       return body;
     }
   }
   ```

3. Let `ExternalServiceError` reach the error filter (502, or 504 on a timeout, reported as a
   dependency failure), or catch it where the feature has a fallback (`error.status === 404`:
   not found upstream). POST and PATCH are not retried unless you pass `idempotent: true` with an
   idempotency key the provider honors.
4. Unit specs inject `fetch` and `sleep` (`external-http.spec.ts` shows how).

## Run a job on one instance, or process a message once

```ts
// A scheduled job that must not run on every instance at once:
const run = await this.locks.withLock('jobs:nightly-report', 15 * 60_000, () => this.buildReport());
if (!run.acquired) return; // another instance has it

// A webhook the provider may deliver twice:
const claim = await this.idempotency.claim('webhooks:billing', event.id, 24 * 60 * 60);
if (claim === null) return; // already processed (or in progress)
try {
  await this.apply(event);
} catch (error) {
  await claim.release(); // let the provider's retry through
  throw error;
}
```

`LockService` and `IdempotencyService` are global. They hold across instances with `REDIS_URL`,
within the process without it, and fail closed (503) while Redis is down. For money or anything that
must happen exactly once, make the write itself idempotent in the database
([architecture.md](architecture.md#locks-and-idempotency)).

## Turn on Redis

1. Locally: in the root `.env`, `REDIS_PASSWORD=<the output of openssl rand -hex 24>`; then
   `docker compose --profile redis up -d`.
2. In `apps/api/.env`: `REDIS_URL=redis://:<that password>@127.0.0.1:6379`, and the features to
   move to it: `RATE_LIMIT_STORE=redis`, `CACHE_STORE=redis` (locks and idempotency follow
   `REDIS_URL`).
3. `pnpm dev`: the log says `Redis connected (redis://127.0.0.1:6379)`; readiness shows
   `"redis": "ok"`. Stop the container to see the degraded mode, start it again to see the
   recovery.
4. Production: a private Redis with TLS and an ACL user, `REDIS_URL=rediss://...` from the secret
   store, `REDIS_KEY_PREFIX` per environment ([security.md](security.md#redis)). Set
   `REDIS_REQUIRED=true` only if the application cannot work without it.

## Turn on error tracking

1. Create a Sentry project for the API (Node.js) and one for the web app (browser JavaScript).
2. API: `SENTRY_DSN` from the secret store. Web: `WEB_SENTRY_DSN` on the web container (or in the
   environment of `pnpm dev` to try it locally). `APP_ENVIRONMENT` on both.
3. Deploy images built by CI: their release is the commit SHA.
4. Check: the API logs `error tracking on` at boot; in the browser, `/app-config.json` shows the
   DSN and the CSP header allows Sentry's ingest host. Then set alert rules in Sentry
   (docs/observability.md#alerting).

## Turn on tracing and metrics

1. Try it locally: `docker compose --profile observability up -d`, then
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in `apps/api/.env` and restart `pnpm dev`;
   Grafana at http://localhost:3001 (Explore: Tempo, Prometheus).
2. Deployed: `OTEL_EXPORTER_OTLP_ENDPOINT` of your collector or provider, its credentials in
   `OTEL_EXPORTER_OTLP_HEADERS` (secret store), a sampler (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`,
   `OTEL_TRACES_SAMPLER_ARG=0.1`), `APP_ENVIRONMENT`.
3. Build the dashboards and alerts from docs/observability.md#metrics and #alerting.
4. Kill switch: `OTEL_SDK_DISABLED=true`.

## Pull changes from the team

After `git pull` (or switching branches):

| Changed                       | Run                                                      |
| ----------------------------- | -------------------------------------------------------- |
| `pnpm-lock.yaml`              | `pnpm install`                                           |
| `apps/api/prisma/migrations/` | `pnpm db:migrate` (applies them, regenerates the client) |
| `openapi/openapi.json`        | nothing: the generated types come in the same commit     |
| `apps/api/.env.example`       | copy new variables into your `apps/api/.env`             |

`pnpm dev`, `pnpm lint`, `pnpm typecheck` and the test commands regenerate the Prisma client; if
the editor still shows old types, run "TypeScript: Restart TS Server".

## Raise coverage thresholds or the performance budget

- **Coverage:** when a pull request raises coverage, raise the thresholds in
  `apps/api/vitest.config.ts` and `apps/web/vite.config.ts` to the new values, rounded down, in the
  same pull request. When new code lowers coverage below the floor, the gate fails: add the missing
  tests (usually error paths and every service method). Lowering a threshold needs a reviewed
  reason ([testing.md](testing.md#coverage)).
- **Performance budget:** `apps/web/performance-budget.json`. Before raising it, try lazy-loading
  the route (`React.lazy`) or a lighter dependency.

## Add another app or a background worker

See [architecture.md](architecture.md#extending): a new folder in `apps/` with its own
`package.json` (the workspace and the root commands pick it up), a tsconfig extending
`tsconfig.base.json`, `typecheck`/`test`/`build` scripts, and its own Dockerfile. Add its image to
`.github/workflows/docker-images.yml`. Code outside `apps/` that an image needs (a shared
`packages/` folder) must also be added to the allowlist in `.dockerignore`. A background worker
fed by a job queue follows the integration point in
[architecture.md](architecture.md#job-queues): same observability setup and shutdown sequence,
idempotent jobs, ids (not personal data) in payloads.

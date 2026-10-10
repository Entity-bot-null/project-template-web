# Authorization

Who may do what is decided by the API, on every request. The web app only decides what to
**show** (`RequireAuth`, `RequireRole`): a hidden link or a client guard is never the protection.

Three checks, all required:

| Check                                | Question                                 | Where                                                        | Answer when refused |
| ------------------------------------ | ---------------------------------------- | ------------------------------------------------------------ | ------------------- |
| Authentication                       | Is there a valid access token?           | `@Auth()` on the controller (`JwtAuthGuard`)                 | 401                 |
| Role (RBAC)                          | May this kind of account use this route? | `@Auth('admin')`, or `@RequireRoles('admin')` on one handler | 403                 |
| Object level (BOLA/IDOR, OWASP API1) | May this caller touch **this** record?   | the service, **inside the query**                            | 404                 |

Broken object-level authorization is the most common API vulnerability: a signed-in user changes
an id in a URL and reads or changes someone else's record. Linters and SAST cannot see it, since
the code is valid; only the rules below, and tests that try it, catch it.

## Roles

`@Auth()` on a controller protects every handler in it, including the ones added later. To narrow
one handler to a role, use `@RequireRoles('admin')`. A handler-level `@Auth('admin')` inside an
`@Auth()` controller would register the guards a second time and run them twice. A handler's roles
replace its controller's (`RolesGuard`), and a handler without roles inherits them, so a handler
can never loosen an `@Auth('admin')` controller. Roles live in `common/types/request-user.ts` and
the Prisma `Role` enum, and adding one is a recipe of its own ([how-to.md](how-to.md#add-a-role)).

## Object level: the rules

1. **Ownership goes into the query** that reads or writes the record, never into a check after it:

   ```ts
   const note = await this.prisma.note.findFirst({
     where: { id, ownerId: actor.id },
     select: NOTE_SELECT,
   });
   if (!note) throw new NotFoundException('Note not found');
   ```

   A fetch-then-compare is a second step to forget, and a concurrent change can slip in between.
   With the filter in the query, a record the caller may not see simply does not exist.

2. **Someone else's record answers 404**, with exactly the body of a missing one, so ids cannot be
   probed for existence. 403 is for a record the caller may see but not change, for example a
   read-only member of a shared resource.
3. **The caller comes from the token, never from the request.** `@CurrentUser()` gives the
   caller. An owner id in the body, the query string or a header is ignored or refused, and the
   DTO schemas do not accept one. On creation, `ownerId` is the caller's id.
4. **Writes are scoped too, in one statement.** Use `updateMany` or `deleteMany` with the same
   filter, then check the count: 0 means not found (404).

   ```ts
   const { count } = await this.prisma.note.deleteMany({ where: { id, ownerId: actor.id } });
   if (count === 0) throw new NotFoundException('Note not found');
   ```

   When the write needs the record first, read it with the scoped filter inside the same
   transaction.

5. **Lists are scoped and paginated.** The count uses the same filter, so a total never reveals
   other users' records.
6. **Nested routes check the whole path** in one query. For `/projects/:projectId/tasks/:taskId`:

   ```ts
   where: { id: taskId, project: { id: projectId, ownerId: actor.id } }
   ```

7. **Shared records** (teams, sharing) use a membership table. The filter becomes
   `members: { some: { userId: actor.id } }`, and stays in the query.
8. **Admin access is explicit**, written in the filter where the product needs it:

   ```ts
   where: {
     AND: [{ id }, actor.role === 'admin' ? {} : { ownerId: actor.id }];
   }
   ```

   If the product must audit who read whose data, log admins' reads of other users' records
   (REQUIERE CONFIGURACIÓN).

9. **Unguessable ids are not authorization.** UUIDs make enumeration hard, not impossible: ids
   leak through logs, links and shared screens. Validate their format (`ParseUUIDPipe`, so a
   malformed id is a 400), and still apply every rule above.
10. **Authorization is never cached.** A decision or a role in a cache outlives its change. Cache
    keys of owned data include the owner ([architecture.md](architecture.md#cache)).

In the template, `UsersService.findVisible` applies rules 1, 2 and 8: a member reads only their own
record, an admin any. The **notes** module of [how-to.md](how-to.md#add-an-api-module) is the full
recipe for a new owned resource: the model with `ownerId` and its index, scoped reads and writes,
and the tests.

## Tests

Every route on one owned record gets the **access matrix**: `expectRecordAccess` in
`apps/api/test/access.ts`.

```ts
await expectRecordAccess(t.server, {
  path: (id) => `/api/notes/${id}`,
  id: note.id,
  owner: asUser(t.app, alice.id),
  other: asUser(t.app, bob.id),
});
```

It checks four things:

- without a token, 401;
- from another account, 404 with exactly the body a missing record gets;
- the owner gets through: 200, or `status`;
- so does an admin, when `admin` is given.

Writes pass `method` and `body`. A delete checks the admin with a record of its own, since the
owner's call removes it. Lists get a test that another account's list neither contains the
record nor counts it. Unit tests assert the filter in the query (`users.service.spec.ts`).

## Review

The [code review checklist](code-review.md) asks for these on every change:

- [ ] Every route: `@Auth(...)` with the right roles, or public on purpose, with the reason in a
      comment.
- [ ] Every query on an owned model carries the owner filter; every write is scoped and checks
      its count.
- [ ] No owner id taken from the request.
- [ ] An access-matrix test for each new route on one record, and a scoped-list test.

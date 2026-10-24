# Your first feature

A worked example that touches every layer: **add a "pin" flag to tasks** so a user
can pin important tasks and have them sort first. It exercises DB → types → API →
workflow → UI → tests — the AURA vertical slice. Use the `aura-feature` skill to
drive this for real.

> This is a teaching walkthrough. Follow the real workflow in
> [../workflows/adding-a-feature.md](../workflows/adding-a-feature.md).

## 1. Database (`prisma/schema.prisma`)

Add to `model Task`:

```prisma
pinned Boolean @default(false)
```

Apply: `npm run db:push` (additive — no data loss). No `types.ts` change (boolean,
not an enum).

## 2. API (`src/app/api/companies/[id]/tasks/[taskId]/route.ts`)

Tasks already support `PATCH`. Add `pinned` to that route's Zod schema:

```ts
const UpdateSchema = z.object({
  // ...existing fields...
  pinned: z.boolean().optional(),
});
```

The route already does `await requireWorkspaceAccess(id, "MEMBER")` and
`findFirst({ where: { id: taskId, companyId: id } })` — keep that; never look up a
task by id alone (IDOR).

## 3. Sort behavior (domain)

Wherever tasks are listed for the board (the `tasks` GET route / overview), sort
`pinned` first, then by existing order. Keep this in the query/domain layer, not
the component.

## 4. UI (`src/app/app/[id]/projects/page.tsx`)

Add a pin toggle on the task card using `useMutation("PATCH")`:

```ts
const { mutate } = useMutation("PATCH");
await mutate(`/api/companies/${id}/tasks/${task.id}`, { pinned: !task.pinned });
```

Use existing primitives (`Badge`, icons from `lucide-react`) and `cn()` for
styling. Pinned tasks render with the pin icon and sort to the top.

## 5. Tests

- Unit: if you add a sort helper, test it (`src/lib/.../*.test.ts`).
- API/behavior: assert `PATCH { pinned: true }` persists and that another
  workspace's user gets a 404 (reuse the pattern in
  `src/lib/auth/isolation.test.ts`).
- Run: `npm run typecheck && npm test`.

## 6. Verify

Open the board, pin a task, confirm it sorts first and survives reload. Watch the
activity feed if you emit a `TASK_UPDATED` event.

## 7. Done

Checklist: [../engineering/definition-of-done.md](../engineering/definition-of-done.md).
You changed a schema and an API contract → update
[../architecture/database.md](../architecture/database.md) and the tasks route
entry in [../architecture/api-design.md](../architecture/api-design.md) if the
contract is user-facing.

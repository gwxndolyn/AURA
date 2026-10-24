# API patterns

The canonical conventions and the full route inventory are in
[../architecture/api-design.md](../architecture/api-design.md). Use the `aura-api`
skill to add or change a route. This page is the quick recipe + checklist.

## New endpoint recipe

```ts
import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { emitEvent } from "@/lib/events/emit";

export const dynamic = "force-dynamic";
// export const maxDuration = 60;   // only if the handler does long AI work
type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ title: z.string().min(1).max(120) });

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");   // VIEWER read · MEMBER write · OWNER destructive
  const body = await parseBody(req, Body);
  const row = await prisma.task.create({ data: { companyId: id, ...body } });
  await emitEvent({ companyId: id, type: "TASK_CREATED", message: `Created: ${row.title}` });
  return ok(row, { status: 201 });
});
```

## Checklist

- [ ] Wrapped in `handler()`; `export const dynamic = "force-dynamic"`.
- [ ] `await ctx.params` (Next 15).
- [ ] `requireWorkspaceAccess(id, role)` first; correct role for the method.
- [ ] Zod schema (module-scope); `parseBody` for the body; enums from `@/lib/types`.
- [ ] All queries scoped by `companyId`; nested ids via `findFirst({ id, companyId })`.
- [ ] `ok(data)` / `ok(x,{status:201})` / throw `ApiError`/`AuthError` — no manual try/catch.
- [ ] `emitEvent` for state changes; `audit` for security-relevant actions.
- [ ] `maxDuration` raised if it calls the model / sandbox.
- [ ] Test incl. a cross-workspace 404 (IDOR) where applicable.
- [ ] Inventory + docs updated if the contract is user-facing.

## Verifying authorization manually

```bash
# as another workspace's user, swapping the id must 404, not leak:
curl -s -X GET  localhost:3000/api/companies/<OTHER_ID>/tasks        # → 404
curl -s -X POST localhost:3000/api/companies/<ID>/tasks -d '{"bad":1}' -H 'content-type: application/json'  # → 422
```

# Workflow: adding an API endpoint

Skill: `aura-api`. Conventions: [../architecture/api-design.md](../architecture/api-design.md).
Recipe + checklist: [../engineering/api-patterns.md](../engineering/api-patterns.md).

1. **Pick path & methods** under `src/app/api/companies/[id]/<name>/route.ts` (or
   nested). Follow the existing tree.
2. **Schema** — module-scope Zod; enums from `@/lib/types`.
3. **Handler** — wrap in `handler()`; `export const dynamic = "force-dynamic"`;
   `await ctx.params`.
4. **Authorize first** — `requireWorkspaceAccess(id, role)` (VIEWER read / MEMBER
   mutate / OWNER destructive).
5. **Validate** — `parseBody(req, Schema)`.
6. **Do the work** — call a `lib` function; scope prisma by `companyId`; nested ids
   via `findFirst({ id, companyId })`.
7. **Status & shape** — `ok(data)` / `ok(x,{status:201})`; throw `ApiError`/
   `AuthError` (no try/catch).
8. **Side effects** — `emitEvent` for state changes; `audit` for security actions.
9. **`maxDuration`** if it calls the model/sandbox.
10. **Test** — happy path + validation 422 + **cross-workspace 404 (IDOR)**.
11. **Docs** — add to the route inventory in `api-design.md`.

Verify IDOR by hand: swapping the company id as another user must 404, not leak.

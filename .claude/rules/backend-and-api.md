---
paths: ["src/app/api/**/*.ts", "src/lib/workflows/**/*.ts", "src/lib/company/**/*.ts", "src/lib/db.ts", "src/lib/api.ts"]
---

# Backend & API rules

Full detail: `docs/architecture/api-design.md`, `docs/engineering/backend-patterns.md`.

- Wrap every route in `handler()` from `@/lib/api`. Never write a manual try/catch;
  throw `ApiError`/`AuthError` and let `handler` map them.
- `export const dynamic = "force-dynamic"`. Next 15: `type Ctx = { params: Promise<...> }`
  and `await ctx.params`.
- **Authorize first**: `await requireWorkspaceAccess(id, ROLE)` before touching data.
  Reads → `"VIEWER"`, mutations → `"MEMBER"`, destructive → `"OWNER"`. Non-company
  routes → `requireUser()`.
- Validate bodies with a module-scope Zod schema via `parseBody(req, Schema)`; take
  enums from `@/lib/types`.
- Scope EVERY prisma query by `companyId`. Nested ids: `findFirst({ where: { id, companyId } })`
  — never `findUnique({ where: { id } })` on a company resource (IDOR).
- Return `ok(data)` / `ok(x, { status: 201 })`.
- Keep business logic in `src/lib/*`; routes stay thin. Domain functions take
  `companyId` first.
- Emit `emitEvent(...)` for state changes; `audit(...)` for security-relevant actions.
- Raise `maxDuration` when the handler calls the model/sandbox.
- No raw SQL — Prisma only. DB access via the `prisma` singleton from `@/lib/db`.
- Add a cross-workspace 404 (IDOR) test for every new company route.

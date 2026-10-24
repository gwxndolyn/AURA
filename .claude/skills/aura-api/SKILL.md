---
name: aura-api
description: Add or modify an AURA API endpoint following the house conventions — handler() wrapper, requireWorkspaceAccess, Zod parseBody, companyId scoping, consistent ok/err responses, events, and an IDOR test. Use when touching src/app/api routes.
---

# aura-api

## When to use
Adding/modifying a route under `src/app/api/**/route.ts`.

## Required context
`docs/architecture/api-design.md`, `docs/engineering/api-patterns.md`,
`docs/workflows/adding-an-api.md`. Code: `src/lib/api.ts`, `src/lib/auth/authz.ts`.

## Workflow
1. Pick path + methods, following the existing tree.
2. Module-scope Zod schema; enums from `@/lib/types`.
3. `export const dynamic = "force-dynamic"`; `type Ctx = { params: Promise<...> }`;
   wrap in `handler()`; `await ctx.params`.
4. **Authorize first**: `requireWorkspaceAccess(id, ROLE)` — read=VIEWER,
   mutate=MEMBER, destructive=OWNER.
5. `parseBody(req, Schema)`.
6. Call a `src/lib` function; scope prisma by `companyId`; nested ids via
   `findFirst({ id, companyId })`.
7. `ok(data)` / `ok(x,{status:201})`; throw `ApiError`/`AuthError` (no try/catch).
8. `emitEvent` for state changes; `audit` for security actions; raise `maxDuration`
   if AI/sandbox.
9. Test: happy path, 422 bad body, **cross-workspace 404 (IDOR)**.
10. Add the route to the inventory in `api-design.md`.

## Security
Authorize before data access; scope by `companyId`; never `findUnique` by id alone
on a company resource. Verify by hand: swapping the id as another user → 404.

## Validation
`npm run typecheck && npm test`. Optionally `curl` the deny/validation paths.

## Definition of done
Canonical route (authz + Zod + scoping + events), IDOR test, inventory + docs
updated, checks green.

## Final report
Route + methods · auth role · schema · tests (incl. IDOR) + results · inventory
updated.

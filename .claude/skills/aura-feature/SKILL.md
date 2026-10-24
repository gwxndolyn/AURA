---
name: aura-feature
description: Implement an AURA feature end-to-end as a vertical slice (UI + API + domain + DB + tests). Use when adding or extending product functionality. Prevents frontend-only work when backend is required.
---

# aura-feature

Implement a feature as the smallest complete **vertical slice**. Reuse AURA's
choke points; never stub the backend.

## When to use
Adding or extending any product capability (a page + its API + domain logic + data
+ tests). If it only touches one layer, a narrower skill may fit (`aura-api`,
`aura-database-change`).

## Required context
- `docs/architecture/overview.md`, `repository-map.md`
- `docs/workflows/adding-a-feature.md`, `docs/getting-started/first-feature.md`
- Rules auto-load for the files you edit (`.claude/rules/`).

## Workflow
1. **Clarify** the user story + acceptance criteria (write them down).
2. **Inspect**: grep for related code; read the nearest route/workflow/component.
   Reuse before adding — no duplication.
3. **Trace** the path: page → `useQuery/useMutation` → route (`handler` → authz →
   `parseBody`) → `src/lib` domain fn → prisma → `emitEvent`. Say which layers change.
4. **Security/data**: tenant scope, `requireWorkspaceAccess` role, input + AI-output
   validation.
5. **Plan** the minimal slice; if a design choice is ambiguous, ask.
6. **Implement back-to-front**: `prisma/schema.prisma` → `src/lib/types.ts` (if enum)
   → API route (Zod + authz, scope by `companyId`) → domain logic in `src/lib` →
   UI (`components/ui` primitives + `useApi` hooks). Emit events for state changes.
7. **Test**: pure-logic unit test; **cross-workspace 404 (IDOR)** test for new
   routes; e2e if a journey changed.
8. **Verify** the journey in the running app (`AURA_DIST_DIR=/tmp/aura-next npm run dev`).
9. **Docs**: update changed contracts.

## Files to inspect
`src/app/api/companies/[id]/**`, `src/lib/workflows/*`, `src/app/app/[id]/*`,
`src/components/*`, `src/hooks/useApi.ts`, `prisma/schema.prisma`, `src/lib/types.ts`.

## Standards
Reuse `complete()`/`callTool`/`requireWorkspaceAccess`/`ok`/`err`/`emitEvent`.
Semantic Tailwind tokens. No new dependency without justification. On this machine
use `AURA_DIST_DIR=/tmp/aura-next` for dev/build.

## Security
Scope every query by `companyId`; nested ids via `findFirst({ id, companyId })`;
correct authz role; validate input and model output; no secret client-side.

## Validation
`npm run typecheck && npm test` (+ `npm run test:e2e` if a journey changed). Run
them; don't claim results you didn't observe.

## Definition of done
See `docs/engineering/definition-of-done.md`. All boxes, including tests you ran
and docs updated.

## Final report
What changed (files by layer) · tests run + actual results · the journey verified ·
any contract/doc updates · anything unverified.

# Prompt: feature development

**When to use** — implement a new feature as a vertical slice (UI + API + domain +
DB + tests).

**What to provide** — the user story, acceptance criteria, and any constraints.

## The prompt

```
Use the `aura-feature` skill. Implement this feature in AURA:

FEATURE: [FEATURE_DESCRIPTION]
ACCEPTANCE CRITERIA:
- [CRITERION_1]
- [CRITERION_2]

Before writing code:
1. Read docs/architecture/overview.md and repository-map.md; grep for existing
   related code and reuse it — do not duplicate.
2. Trace the request path (page → useQuery/useMutation → route → lib → prisma →
   emitEvent) and tell me which layers must change.
3. Identify tenant-scope, requireWorkspaceAccess role, input validation, and any
   AI/untrusted-content implications.
4. Give me a minimal plan (smallest vertical slice) and wait if a design choice is
   ambiguous.

Then implement back-to-front: schema → src/lib/types.ts (if enum) → API route
(handler + Zod + requireWorkspaceAccess, scope by companyId) → domain logic in
src/lib → UI with components/ui primitives and the useApi hooks. Emit events for
state changes. Reuse complete()/callTool/the api.ts helpers — never bypass them.

Add tests: a pure-logic unit test, a cross-workspace 404 (IDOR) test for any new
route, and e2e if a user journey changed. RUN: npm run typecheck && npm test
(and npm run test:e2e if a journey changed). Report exactly what passed.
Update docs for any changed contract.
```

## Expected deliverables
Working slice across all needed layers; tests that run green; events wired; docs
updated.

## Verification
`npm run typecheck`, `npm test` (+ e2e), and a manual pass of the journey in the
running app.

## Common failure modes
Frontend-only stub when backend is needed; unscoped query (IDOR); duplicated logic;
claiming tests passed without running; missing doc update.

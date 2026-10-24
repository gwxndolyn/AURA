# Prompt: API development

**When to use** — add or change an API endpoint.

**What to provide** — the route, methods, request/response, and auth level.

## The prompt

```
Use the `aura-api` skill. Add/modify an AURA API endpoint.

ROUTE: [PATH e.g. companies/[id]/widgets]
METHODS: [GET/POST/...]
REQUEST/RESPONSE: [SHAPES]
AUTH: [read=VIEWER / mutate=MEMBER / destructive=OWNER]

Follow docs/architecture/api-design.md exactly:
1. handler() wrapper; export const dynamic="force-dynamic"; type Ctx with
   params:Promise<...>; await ctx.params.
2. requireWorkspaceAccess(id, ROLE) FIRST.
3. Module-scope Zod schema; parseBody(req, Schema); enums from @/lib/types.
4. Scope every prisma query by companyId; nested ids via findFirst({id,companyId}).
5. ok(data)/ok(x,{status:201}); throw ApiError/AuthError — no try/catch.
6. emitEvent for state changes; audit for security actions; maxDuration if AI/sandbox.
7. Tests: happy path, 422 on bad body, and a cross-workspace 404 (IDOR).
8. RUN npm run typecheck && npm test. Add the route to the inventory in api-design.md.

Verify a different workspace's user cannot access data by swapping the resource id.
```

## Expected deliverables
A canonical route with authz, validation, scoping, events, and an IDOR test; docs
updated.

## Verification
`curl` with a swapped id → 404; bad body → 422; tests green.

## Common failure modes
Missing/again-wrong role; `findUnique` by id (IDOR); manual try/catch; no IDOR test.

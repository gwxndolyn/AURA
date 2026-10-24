---
name: aura-code-review
description: Review an AURA change as a senior engineer — correctness, security, tenancy, architecture, data integrity, errors, concurrency, performance, tests, regressions — ranked by severity with exact file:line. Use before merging a change.
---

# aura-code-review

## When to use
Reviewing a diff/PR/branch/files before merge. For an automated pass you can also
use the built-in `/code-review`.

## Required context
`docs/engineering/code-review.md`, `docs/security/*`, `docs/architecture/*`.

## Review order (most important first)
1. **Correctness** — edge cases, null/empty, error paths.
2. **Security & tenancy** — `companyId` scoping, IDOR via `findUnique`,
   `requireWorkspaceAccess` role, no `NEXT_PUBLIC_` secrets, Zod validation,
   untrusted AI/retrieved content handled.
3. **Architecture** — logic in `src/lib`, choke points used, no duplication.
4. **Data integrity** — safe/additive migrations, `parseJSON` fallbacks.
5. **Error handling** — typed errors, no swallowed catches, flagged fallbacks.
6. **Concurrency** — no floating promises; parallelized independent awaits.
7. **Performance** — N+1, redundant model calls, oversized context.
8. **Tests** — right type, runnable, IDOR/permission coverage, actually run.
9. **Maintainability** — reads like surrounding code; no speculative abstraction.
10. **Regressions**.

## Output
Rank findings **Critical/High/Medium/Low** with exact `file:line`. If clean, say so.

## Must NOT
Invent problems to lengthen the report; nitpick style over correctness/security.

## Final report
Ranked findings (severity + file:line + fix) and an overall verdict.

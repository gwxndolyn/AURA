---
name: aura-debug
description: Diagnose and fix a bug in AURA systematically — reproduce, trace the failing path, find the root cause, make a targeted fix, and add a regression test. Use for any defect with wrong observable behavior.
---

# aura-debug

## When to use
A defect with observable wrong behavior. Not for new features (`aura-feature`).

## Required context
`docs/workflows/fixing-a-bug.md`, `docs/engineering/error-handling.md`,
`docs/architecture/repository-map.md`.

## Workflow
1. **Reproduce** — write the exact repro (input/sequence). Can't reproduce → say so
   and ask for what's missing; don't guess a fix.
2. **Expected vs actual** — state both precisely.
3. **Evidence** — `[api error]` logs, `/activity` + `/audit`, failing entity state,
   failing test output.
4. **Trace** the failing path (route → `src/lib` → prisma/model/tool). Read, not guess.
5. **Root cause** — the real defect, not a symptom.
6. **Targeted fix** — smallest change; no scope creep.
7. **Regression test** — fails before, passes after (mirror `isolation.test.ts` for
   security bugs).
8. **Rerun** the failing test + `npm run typecheck && npm test`.

## Files to inspect
The route/component in the symptom, its `src/lib` workflow, `prisma/schema.prisma`,
relevant `*.test.ts`.

## Security
If it's an auth/tenant bug (IDOR), fix with `findFirst({ id, companyId })` and add a
cross-workspace denial test.

## Validation
Run the regression test (red→green) + `npm run typecheck && npm test`. Report output.

## Definition of done
Root cause named, minimal fix, regression test runs green, related checks green.

## Must NOT
Hide the bug behind a catch-all exception, an arbitrary `sleep()`, or a fallback
that fakes success.

## Final report
Repro · root cause (file:line) · the fix · regression test + its red→green result ·
related checks run.

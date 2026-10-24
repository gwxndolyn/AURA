# Workflow: fixing a bug

Skill: `aura-debug`.

1. **Reproduce** — a concrete input/sequence that triggers it. If you can't
   reproduce, you can't verify a fix.
2. **Expected vs actual** — state both precisely.
3. **Collect evidence** — server logs (`[api error]`), `/activity` + `/audit`
   events, the failing entity's state (task status, deployment `stages`), test
   output.
4. **Trace the failing path** — route → workflow → prisma / model / tool. Use the
   [repository map](../architecture/repository-map.md). Read, don't guess.
5. **Root cause** — the actual defect, not a symptom.
6. **Targeted fix** — the smallest change that fixes the cause. Don't refactor
   around it or widen scope.
7. **Regression test** — add a test that fails before and passes after. For a
   security bug (e.g. IDOR), mirror `isolation.test.ts`.
8. **Rerun** the failing test + related checks (`npm run typecheck && npm test`).

**Never** hide a bug behind a catch-all exception, an arbitrary `sleep()`, or a
fallback that fakes success. If the real cause can't be fixed now, say so and open
a follow-up — don't paper over it. ([error-handling](../engineering/error-handling.md))

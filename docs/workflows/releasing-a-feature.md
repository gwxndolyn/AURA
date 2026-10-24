# Workflow: releasing a feature

Skill: `aura-release`. Prompt: [../prompts/release-readiness.md](../prompts/release-readiness.md).
Deploy detail: [../operations/deployment.md](../operations/deployment.md).

Verify each; **block the release if a critical check fails.**

1. **Acceptance criteria** met and demonstrated.
2. **Migrations** — schema changes applied; additive/safe; rollback known.
3. **Tests** — `npm run typecheck`, `npm run lint`, `npm test` green; `npm run
   test:e2e` for changed journeys. You ran them.
4. **Build** — `npm run build` succeeds (prefix `AURA_DIST_DIR=` here).
5. **Security-sensitive changes** reviewed (`aura-security-audit`): new routes have
   IDOR tests, new tools have permission tests, no secret leaked.
6. **Config/env** — new env vars documented in `.env.example` + env docs; defaults
   sane; secrets in the platform store.
7. **Observability** — `/api/health` reflects any new subsystem; events/audit for
   new state changes.
8. **Rollback** — a concrete plan (previous build; data restore).
9. **Release notes** — what changed, breaking changes called out.
10. **Docs** — contracts updated; `node scripts/check-docs.mjs` passes.

Report what was **verified** vs **assumed**. "Should work" is not "verified".

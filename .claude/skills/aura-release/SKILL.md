---
name: aura-release
description: Prepare and gate an AURA release — verify acceptance criteria, migrations, tests, build, security-sensitive changes, config/env, observability, rollback, and release notes. Blocks the release if a critical check fails. Use before shipping.
---

# aura-release

## When to use
Deciding whether a change is ready to ship.

## Required context
`docs/workflows/releasing-a-feature.md`, `docs/operations/deployment.md`,
`docs/prompts/release-readiness.md`.

## Checklist (verify each; report VERIFIED vs ASSUMED)
1. Acceptance criteria met + demonstrated.
2. Migrations applied, additive/safe, rollback known.
3. **Run** `npm run typecheck && npm run lint && npm test` (+ `test:e2e` for changed
   journeys). Paste results.
4. **Run** `npm run build` (`AURA_DIST_DIR=/tmp/aura-next`).
5. Security-sensitive changes reviewed (IDOR tests on new routes, permission tests
   on new tools, no secret leak).
6. Config/env: new vars in `.env.example` + env docs; secrets in platform store.
7. Observability: `/api/health` reflects new subsystems; events/audit for new state.
8. Rollback plan concrete.
9. Release notes incl. breaking changes.
10. `node scripts/check-docs.mjs` passes.

## Decision
Give a **GO / NO-GO**. **Block (NO-GO)** if any critical check fails.

## Must NOT
Claim a check passed without running it; wave through a failing critical check.

## Definition of done
Every pass backed by observed output; a clear GO/NO-GO with the VERIFIED/ASSUMED
split.

## Final report
Per-item status (verified vs assumed) with command output · GO/NO-GO · blockers.

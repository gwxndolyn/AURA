# Prompt: release readiness

**When to use** — decide if a change is ready to ship.

**What to provide** — what's in the release.

## The prompt

```
Use the `aura-release` skill. Assess release readiness for AURA.

IN THIS RELEASE: [FEATURES / FIXES]

Verify each and report VERIFIED vs ASSUMED/UNTESTED:
1. Acceptance criteria met + demonstrated.
2. Migrations applied, additive/safe, rollback known.
3. Tests: RUN npm run typecheck && npm run lint && npm test (+ test:e2e for changed
   journeys). Paste results.
4. Build: RUN npm run build (AURA_DIST_DIR=/tmp/aura-next). 
5. Security-sensitive changes reviewed (IDOR tests for new routes, permission tests
   for new tools, no secret leak).
6. Config/env: new vars in .env.example + env docs; secrets in platform store.
7. Observability: /api/health reflects new subsystems; events/audit for new state.
8. Rollback plan concrete.
9. Release notes incl. breaking changes.
10. node scripts/check-docs.mjs passes.

Give a GO / NO-GO. BLOCK (NO-GO) if any critical check fails. Do not claim a check
passed unless you ran it.
```

## Expected deliverables
A GO/NO-GO with real command output and a clear VERIFIED/ASSUMED split.

## Verification
Every "pass" is backed by output you can see.

## Common failure modes
Claiming green without running; ignoring a failing critical check; hand-waving
"should work".

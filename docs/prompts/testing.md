# Prompt: test coverage improvement

**When to use** — fill test gaps based on risk and behavior (not coverage %).

**What to provide** — the area and recent changes.

## The prompt

```
Use the `aura-test` skill. Improve test coverage for [AREA] in AURA.

RECENT CHANGES / RISK: [WHAT_CHANGED_OR_WHAT_IS_RISKY]

1. Read the code + existing tests (8 Vitest files in src, e2e/journey.spec.ts).
   Identify gaps by RISK and BEHAVIOR, not line coverage.
2. Choose the right test type per behavior:
   - pure logic (scoring/formatting/parsing) → unit, no DB (like prioritize.test.ts)
   - permissions/registry → unit (like permissions.test.ts)
   - auth/tenant scoping → unit, cross-workspace must 404 (like isolation.test.ts)
   - sandbox/codegen → unit guarded on dockerAvailable()
   - a user journey → Playwright e2e
   - AI behavior → eval cases asserting shape/invariants (see aura-ai-evaluation)
3. Implement the missing tests. Prefer real behavior over mocks; guard
   environment-dependent tests instead of faking.
4. RUN npm test (and npm run test:e2e if a journey). Report actual pass/fail.

Every new company route needs a cross-workspace denial test; every new tool a
permission test. Don't chase a coverage number.
```

## Expected deliverables
Risk-prioritized tests that run, including security coverage; real results.

## Verification
Tests pass; they fail if the behavior regresses (spot-check by breaking it).

## Common failure modes
Testing for coverage %; mocking away the real behavior; skipping security tests.

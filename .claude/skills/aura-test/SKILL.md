---
name: aura-test
description: Build and run an appropriate test strategy for an AURA change — choose test types by risk and behavior (unit, API/tenant, sandbox, e2e, AI eval), implement, execute, and report real results. Use when adding or improving tests.
---

# aura-test

## When to use
Adding/improving tests, or verifying a change is covered by the right kind of test.

## Required context
`docs/engineering/testing-strategy.md`, `docs/ai-engineering/evaluation-and-testing.md`.
Existing: 8 Vitest files in `src/**/*.test.ts`, `e2e/journey.spec.ts`.

## Workflow
1. Read the code + existing tests; find gaps by **risk and behavior**, not coverage %.
2. Pick the type per behavior:
   - pure logic → unit, no DB (`prioritize.test.ts`)
   - permissions/registry → unit (`permissions.test.ts`)
   - auth/tenant → unit, cross-workspace must 404 (`isolation.test.ts`)
   - sandbox/codegen → unit guarded on `dockerAvailable()` (`runner.test.ts`)
   - user journey → Playwright e2e
   - AI behavior → eval cases on shape/invariants (use `aura-ai-evaluation`)
3. Implement; prefer real behavior over mocks; guard env-dependent tests, don't fake.
4. Run `npm test` (+ `npm run test:e2e` if a journey). Report actual pass/fail.

## Security coverage (mandatory)
Every new company route → a cross-workspace denial test. Every new tool → a
permission test.

## Validation
`npm test` (and `npm run test:e2e` with `test:e2e:install` once). Observe results.

## Definition of done
Risk-prioritized tests that run green and fail when the behavior regresses
(spot-check). Security cases included.

## Must NOT
Chase a coverage number; mock away real behavior; claim passing without running.

## Final report
Gaps found · tests added (type + file) · commands run + actual results · remaining
untested risk.

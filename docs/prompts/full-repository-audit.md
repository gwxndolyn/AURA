# Prompt: full repository audit

**When to use** — take stock: inventory broken functionality, security risks,
tech debt, and missing tests, then prioritize.

**What to provide** — nothing required; optionally a focus.

## The prompt

```
Audit the AURA repository and produce a prioritized remediation plan.

FOCUS (optional): [AREA]

1. Build an inventory (reference real files/paths):
   - BROKEN or incomplete functionality (TODO/stub/partial, routes without tests).
   - SECURITY risks: any findUnique on a company resource (IDOR), unscoped queries,
     NEXT_PUBLIC_ secrets, raw SQL, over-broad tool allowlists, weakened sandbox
     flags, missing requireWorkspaceAccess.
   - TECH DEBT: duplicated logic, bypassed choke points, speculative abstractions.
   - MISSING TESTS by risk (new routes without IDOR tests, tools without permission
     tests, untested workflows).
   - DOCS drift (run node scripts/check-docs.mjs).
2. For each item: severity, effort estimate, and the concrete fix.
3. Rank into a remediation plan (Critical → Low). Do NOT fix yet — produce the plan
   and wait.

Verify claims against the code; mark anything uncertain as unverified. Don't invent
problems; don't attack real systems.
```

## Expected deliverables
A grounded inventory + a ranked remediation plan with severity/effort/fix.

## Verification
Each item traces to a real file; `check-docs.mjs` run; no invented issues.

## Common failure modes
Vague findings; no prioritization; starting fixes before the plan is agreed;
fabrication.

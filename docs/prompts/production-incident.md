# Prompt: production incident

**When to use** — a live production failure needing safe mitigation and recovery.

**What to provide** — the symptom, when it started, and who's affected.

## The prompt

```
Use the `aura-incident-response` skill. Investigate this AURA production incident.

SYMPTOM: [WHAT_IS_FAILING]
STARTED: [WHEN]
AFFECTED: [WHO / WHICH_WORKSPACES]

1. Establish impact + scope. Start from /api/health and /api/ai/status.
2. Collect + PRESERVE evidence ([api error] logs, /activity, /audit, failing
   entity state, recent deploys) before mutating anything.
3. Triage: which subsystem/boundary? Use docs/operations/troubleshooting-production.md.
4. Mitigate SAFELY — reversible first (restart/scale/flag off). STOP and ask for
   explicit human approval before any destructive or consequential production
   action. NEVER db:reset production.
5. Find the root cause.
6. Implement + test a fix with a regression test.
7. Verify recovery (/api/health HEALTHY; original trigger no longer fails).
8. Write the incident up: impact, timeline, root cause, fix, prevention.

Require approval for destructive actions. Report what you did and verified.
```

## Expected deliverables
Scope, preserved evidence, a safe mitigation, root cause, tested fix, verified
recovery, write-up.

## Verification
Health back to HEALTHY; the trigger reproduced-then-fixed; regression test added.

## Common failure modes
Mutating before preserving evidence; destructive action without approval; fixing a
symptom; no write-up.

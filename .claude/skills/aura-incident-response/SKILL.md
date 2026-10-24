---
name: aura-incident-response
description: Investigate a production or workflow incident in AURA — establish scope, preserve evidence, triage, mitigate safely (reversible first), find root cause, fix with a regression test, verify recovery, and document. Requires approval for destructive actions.
---

# aura-incident-response

## When to use
A live production or workflow failure needing safe mitigation + recovery.

## Required context
`docs/operations/troubleshooting-production.md`, `docs/workflows/incident-response.md`,
`docs/prompts/production-incident.md`.

## Workflow
1. **Scope & impact** — what's broken, for whom, since when. Start from
   `/api/health` + `/api/ai/status`.
2. **Preserve evidence** before mutating: `[api error]` logs, `/activity`,
   `/audit`, failing entity state, recent deploys.
3. **Triage** — which subsystem/boundary.
4. **Mitigate safely** — reversible first (restart/scale/flag off). **Require
   explicit human approval** before any destructive/consequential production action.
   NEVER `db:reset` production.
5. **Root cause** — traced through the layers.
6. **Fix + regression test** reproducing the incident.
7. **Verify recovery** — `/api/health` HEALTHY; original trigger no longer fails.
8. **Document** — impact, timeline, root cause, fix, prevention; update the threat
   model/doc if a control was missing.

## Hard rules
Approval for destructive/consequential actions; preserve evidence before changing
state; cyber range stays isolated.

## Validation
`/api/health` HEALTHY; regression test green; original trigger fixed.

## Definition of done
Scope established, evidence preserved, safe mitigation, root cause, tested fix,
verified recovery, written up.

## Final report
Impact/scope · timeline · root cause · mitigation (+ approvals) · fix + test ·
recovery verification · prevention.

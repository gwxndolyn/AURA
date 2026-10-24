# Workflow: incident response

Skill: `aura-incident-response`. Production detail:
[../operations/troubleshooting-production.md](../operations/troubleshooting-production.md).
**Require human approval for destructive or consequential production actions.**

1. **Impact & scope** — what's broken, for whom (which companies/workspaces), since
   when. Start from `GET /api/health`.
2. **Collect evidence** — logs (`[api error]`), `/activity` + `/audit`, metrics,
   recent changes/deploys, the failing entity's state. Preserve before mutating.
3. **Affected services/workspaces** — identify precisely; don't guess the blast
   radius.
4. **Mitigate safely** — reversible first (restart, scale, flag off the path). Get
   approval before anything destructive. Never `db:reset` production.
5. **Preserve evidence** for root-cause (don't overwrite logs/state you'll need).
6. **Root cause** — the actual defect, traced through the layers.
7. **Fix & test** — targeted fix + a regression test that reproduces the incident.
8. **Verify recovery** — `/api/health` HEALTHY; the original trigger no longer
   fails.
9. **Document** — impact, timeline, root cause, fix, prevention; update the threat
   model/doc if a control was missing.

This mirrors AURA's own simulated incident flow (`workflows/security.ts`):
detect → contain → patch → verify → recompute security score.

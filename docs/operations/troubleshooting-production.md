# Troubleshooting (production)

Pair with the `aura-incident-response` skill. **Require human approval for
destructive or consequential production actions.**

## First: establish scope

1. `GET /api/health` — which subsystem is DOWN/DEGRADED?
2. `GET /api/ai/status` — mode + sandbox as expected?
3. Affected companies/workspaces? Recent deploys/changes? (`/audit`, `/activity`.)
4. Preserve evidence (logs, audit rows, the failing deployment's `stages`) before
   mutating anything.

## Symptoms → likely cause

| Symptom | Likely cause | Action |
|---|---|---|
| SSE feed dead across instances | in-process bus, multiple instances | front with a single instance or add a Redis-backed bus |
| Agents idle / costs flat | budget hard-stop hit (`overBudget`) | check `/usage`; raise `AURA_DAILY_BUDGET_USD` deliberately or wait for day roll |
| Coding tasks never "real sandbox" | no Docker daemon on host | provide Docker or accept flagged simulated results |
| `database DOWN` in health | DB unreachable / file perms | check `DATABASE_URL`, connectivity, disk |
| 500s on a route | unhandled error (`[api error]` log) | read the log; add a typed error / fix the bug |
| Cross-tenant data seen | an unscoped query / `findUnique` by id | audit the route; enforce `findFirst({id,companyId})` |
| Long work lost after deploy/scale | fire-and-forget on scale-to-zero | move to durable workflow (`aura-autonomous-workflow`) |

## Mitigate safely

- Prefer reversible mitigations first (restart, scale, feature-flag off the path).
- For a bad deploy, roll back to the previous build; AURA's own simulated
  deployments can be marked `ROLLED_BACK` but that's product state, not infra.
- Get approval before destructive data operations. **Never** `db:reset` production.

## Recover & verify

- Restore data from backup if needed (SQLite: volume snapshot; Postgres: dump).
- Re-run `GET /api/health` until `overall: HEALTHY`.
- Confirm the specific failing journey works (reproduce the original trigger).

## Close out

Document the incident: impact, timeline, root cause, fix, prevention. Add a
regression test. Update the relevant doc/threat model if a control was missing.

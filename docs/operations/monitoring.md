# Monitoring & observability

AURA exposes real subsystem status and per-run AI telemetry. There is no external
APM wired in — these are the built-in signals.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/health` | `{ overall, checks, stats, ts }` — probes DB (real `SELECT 1` + latency), Claude mode, Docker sandbox, Redis (configured vs in-memory), event stream, cyber range; plus counts of companies/agentRuns/toolCalls. `overall` is HEALTHY unless a subsystem is DOWN. |
| `GET /api/ai/status` | `{ mode, models, budget, sandbox }` — AI live/simulation, model map, budget config, sandbox docker/simulated. |
| `GET /api/companies/[id]/usage` | token/cost usage, `todayCost`, per-agent cost, `dailyRemaining`, `overBudget`. |
| `GET /api/companies/[id]/audit` | immutable audit log (actions, tool calls). |
| `GET /api/companies/[id]/activity` / `/events` | event history. |
| `GET /api/companies/[id]/stream` | live SSE event feed. |

UI: `/health` (global dashboard), the dashboard activity feed, settings (AI
mode/budget), and the attention panel (actionable issues from real state).

## What to watch

- **`/api/health` overall** — DEGRADED means a subsystem probe failed.
- **Budget** — `overBudget` / `dailyRemaining` (hard-stop at `AURA_DAILY_BUDGET_USD`);
  80%/90% warnings emit `COMPANY_UPDATED` events.
- **Agent failures** — `AGENT_FAILED` events; denied tool calls in the audit log
  (possible injection/abuse signal).
- **Latency/cost per run** — on each `AgentRun`.
- **Infra health** (simulated) — `InfrastructureNode.status`/`errorRate` feed the
  security score.

## Instrumenting new work

- Emit an event (`emitEvent`) on every meaningful state change; `audit` for
  security-relevant actions. Don't swallow failures — surface them.
- If you add a subsystem, add a probe to `/api/health` so its status is visible.
- Keep logs free of secrets and raw sensitive prompt/response content.

## Production

For real deployments, forward `/api/health` to your uptime monitor and ship
structured logs to your platform's log store. External APM/metrics are a documented
next step, not currently in the repo.

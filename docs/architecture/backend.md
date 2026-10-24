# Backend

The backend is Next.js route handlers (`src/app/api/**/route.ts`) plus the domain
layer in `src/lib/`. There is no separate server process.

## Layering (keep this direction)

```
route handler  →  domain (lib/workflows, lib/agents, lib/company)  →  prisma
     │                        │
     │                        └─ model calls via lib/ai/claude.complete()
     │                        └─ tool calls via lib/agents/tools.callTool()
     └─ auth (requireWorkspaceAccess) · validate (parseBody) · respond (ok/err)
                                                   └─ side effects: emitEvent / audit
```

- **Routes stay thin.** They authorize, validate, call one domain function, and
  shape the response. Business logic belongs in `src/lib/`.
- **Domain functions take `companyId` first** and own their Prisma access, event
  emission, and audit logging.
- **No model/tool/DB access that skips the choke points** (`claude.ts`,
  `callTool`, `requireWorkspaceAccess`, `prisma` singleton).

## Where logic lives

| Kind of work | Module |
|---|---|
| Turning a goal into tasks | `workflows/plan.ts` |
| Running a task to DONE (quality gate) | `workflows/executeTask.ts`, `workflows/selfHeal.ts` |
| Deploy pipeline / approvals | `workflows/deploy.ts`, `workflows/approval.ts` |
| Red/blue cyber range | `workflows/security.ts` |
| Sprint / prioritization | `workflows/sprint.ts`, `workflows/prioritize.ts` |
| Agent turn (model call) | `agents/orchestrator.ts` → `ai/claude.ts` |
| Company creation / daily sim | `company/provision.ts`, `company/simulation.ts` |
| Security score | `company/security.ts` |

## Error handling

Throw typed errors; `handler()` maps them:

- `AuthError(status, msg)` — from the auth layer (401/403/404).
- `ApiError(msg, status)` — validation/business errors (400/422/…).
- Anything else → logged `[api error]` + `err(msg, 500)`.

Agent/workflow failures must **not** crash the company — `claude.ts` falls back to
the simulator on API error; the sandbox falls back to a *flagged* simulated result.
Fallbacks are labeled (`mode: "simulation"`, `real: false`), never disguised as
real success. See [../engineering/error-handling.md](../engineering/error-handling.md).

## Guardrails

Before an agent turn, `orchestrator.runAgent` calls `checkBudget` (daily hard-stop
→ `BudgetExceededError`) and `maybeWarnBudget` (80%/90% warnings). Loop limits
(`checkLoop`: iterations/tool-calls/runtime) live in `agents/guardrails.ts`,
configurable via `AURA_MAX_*` env vars. See
[../ai-engineering/token-and-cost-management.md](../ai-engineering/token-and-cost-management.md).

## Background / long work

AURA has no job queue. Long operations run inside the request (with raised
`maxDuration`) or as a fire-and-forget IIFE after responding — see
[events-and-jobs.md](events-and-jobs.md). The `demo` route is the reference
pattern. The daily simulation advances only via explicit UI-driven ticks, so
nothing depends on a server timer.

# Architecture overview

AURA is a single Next.js 15 (App Router) process. There is no separate backend —
server route handlers under `src/app/api/**/route.ts` are the backend. State lives
in SQLite via Prisma (Postgres optional). The browser renders React Server/Client
components and subscribes to a live event stream over SSE.

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser (React 18)                                                │
│  pages src/app/app/[id]/*  ·  components src/components/*         │
│  Zustand store (src/lib/store.ts)  ·  useLiveEvents (SSE hook)   │
└───────────────▲───────────────────────────────┬──────────────────┘
                │ SSE  /api/companies/[id]/stream │ fetch (ok/err envelope)
┌───────────────┴───────────────────────────────▼──────────────────┐
│ Next.js API routes  src/app/api/**/route.ts  (41 routes)         │
│   handler() wrapper → requireWorkspaceAccess() → parseBody(Zod)  │
└───────────────┬───────────────────────────────────────────────────┘
                │ calls
┌───────────────▼───────────────────────────────────────────────────┐
│ Domain layer  src/lib/                                            │
│  workflows/  (plan, executeTask, deploy, security, selfHeal, …)   │
│  agents/     (orchestrator, definitions, memory, permissions,     │
│               tools, guardrails, messaging)                       │
│  ai/         (claude  ← single model entry point →  simulator)    │
│  company/    (provision, simulation, security, attention)         │
│  sandbox/    (docker, runner, codegen)                            │
│  events/     (bus = in-process EventEmitter on globalThis, emit)  │
│  auth/       (authz choke point, session, edge, password, …)      │
└───────────────┬───────────────────────────────┬───────────────────┘
                │ Prisma                          │ emitEvent → bus → SSE
┌───────────────▼──────────────┐   ┌─────────────▼───────────────────┐
│ SQLite (prisma/dev.db)        │   │ Docker sandbox (optional)        │
│ 20+ models, companyId-scoped  │   │ node:20-alpine, --network none   │
└───────────────────────────────┘   └──────────────────────────────────┘
```

## Request lifecycle (runtime AI request)

1. **Route** receives the request; `handler()` wraps it for uniform errors.
2. **Authorize** — `requireWorkspaceAccess(companyId, role)` (401/403/404).
3. **Validate** — `parseBody(req, ZodSchema)` (422 on invalid).
4. **Domain** — a `src/lib/workflows/*` or `src/lib/agents/*` function runs the work.
5. **Model** — any model call goes through `complete()` in `src/lib/ai/claude.ts`,
   which routes by tier and falls back to the simulator with no key / on error.
6. **Tools** — agent tool calls go through `callTool()`, which enforces per-role
   permissions and writes a `ToolCall` audit row.
7. **Persist + emit** — Prisma writes state; `emitEvent()` persists a
   `SimulationEvent` and publishes to the bus → SSE to the browser.
8. **Respond** — `ok(data)` / `err(message, status)`.

## Core design decisions

- **Zero-config.** `npm install && npm run db:push && npm run db:seed && npm run dev`
  works with no API key, no Docker, no Redis/Postgres. Each external dependency has
  a flagged fallback (simulation mode, simulated sandbox, in-memory bus).
- **One model entry point.** `src/lib/ai/claude.ts` is the only place the Anthropic
  SDK is constructed. This gives one spot for routing, cost tracking, and fallback.
- **Deterministic offline engine.** `src/lib/ai/simulator.ts` returns structured
  JSON keyed by a `kind` so the whole product is demoable and testable offline.
- **Security computed, not asked.** `src/lib/company/security.ts` derives the
  security score from real finding/incident/infra state. The model never sets it.
- **Serverless-safe simulation.** Time advances by explicit UI-driven ticks
  (`tickDay`/`advanceDays`), not a server timer.
- **Enums as validated strings.** SQLite has no enums; unions live in
  `src/lib/types.ts` and are validated with Zod at the edge.

## Where to go next

- The file-by-file map: [repository-map.md](repository-map.md)
- API conventions: [api-design.md](api-design.md)
- Data model: [database.md](database.md)
- Agent runtime: [agent-orchestration.md](agent-orchestration.md)
- Sandbox: [sandbox-architecture.md](sandbox-architecture.md)
- AI patterns: [../ai-engineering/overview.md](../ai-engineering/overview.md)

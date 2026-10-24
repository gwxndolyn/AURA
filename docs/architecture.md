# Architecture

One Next.js 15 process (App Router): route handlers are the backend, Prisma
(SQLite by default, Postgres optional) is the store, an in-process event bus +
SSE carries realtime updates, Docker runs untrusted code, and git runs as a
subprocess. Deep dives live in [architecture/](architecture/overview.md).

```mermaid
flowchart TB
  subgraph Browser
    L[Landing + guided demo<br/>src/app/page.tsx]
    UI[Workspace pages<br/>src/app/app/[id]/*]
    OF[Living office<br/>src/components/office]
  end
  subgraph Server["Next.js route handlers (src/app/api)"]
    API[handler · requireWorkspaceAccess · parseBody]
    WH[/api/webhooks/github·gitlab/]
  end
  subgraph Domain["src/lib"]
    FAC[factory/ — product lifecycle,<br/>scheduler, PM/designer/architect,<br/>git, release, webhooks]
    MIS[missions/ — plan, execute,<br/>verify, review, repair, approvals]
    DEV[devspace/ — files, changes,<br/>checks]
    AG[agents/ — registry, capabilities,<br/>permissions, callTool, contracts]
    AI[ai/claude.ts — single model entry<br/>+ simulator fallback]
    EV[events/ — emitEvent, bus]
    OPS[ops/ — AURA health rules]
    TW[twin/ — planning simulation]
  end
  DB[(Prisma DB)]
  DK[[Docker sandbox<br/>--network none]]
  GIT[[git repos<br/>AURA_GIT_ROOT]]
  GH[(GitHub / GitLab<br/>optional)]
  ANT[(Anthropic API<br/>optional)]

  L --> API
  UI --> API
  OF --> API
  API --> FAC & MIS & DEV & OPS & TW
  WH --> FAC
  FAC --> MIS
  FAC --> DEV
  MIS --> AG --> AI --> ANT
  MIS --> DK
  DEV --> DK
  FAC --> GIT
  FAC -. push / PR .-> GH
  FAC & MIS & DEV & AG & OPS --> DB
  FAC & MIS & DEV & OPS --> EV --> UI
  EV --> OF
```

Not present (planned or out of scope): a background worker process, a
production deployment provider, external telemetry ingestion, OAuth/GitHub App
installation.

## Layers

| Concern | Where | Notes |
|---|---|---|
| Frontend + routing | `src/app` (App Router), `src/components`, `src/hooks` | `useQuery` polling + `useLiveEvents` SSE |
| API | `src/app/api/**/route.ts` | `ok/err/handler/parseBody` (`src/lib/api.ts`); conventions in [architecture/api-design.md](architecture/api-design.md) |
| Auth + isolation | `src/lib/auth/*`, `src/middleware.ts` | signed httpOnly session; `requireWorkspaceAccess(id, role)` on every company route; nested ids via `findFirst({ id, companyId })` |
| Product lifecycle | `src/lib/factory/*` | [product-lifecycle.md](product-lifecycle.md) |
| Execution engine | `src/lib/missions/*` | leases, retries, repairs, approvals ([architecture/missions-and-demo.md](architecture/missions-and-demo.md)) |
| Agents | `src/lib/agents/*` | [agent-orchestration.md](agent-orchestration.md) |
| AI provider | `src/lib/ai/claude.ts` | tiers FAST/STANDARD/REASONING; usage + cost (estimated); simulator when no key |
| Code execution | `src/lib/sandbox/*` | Docker, no network, CPU/mem/pids limits, read-only root, timeouts |
| Source control | `src/lib/factory/git.ts` | [repository-integration.md](repository-integration.md) |
| Verification + release | `src/lib/factory/release.ts` | [verification-and-release.md](verification-and-release.md) |
| Events | `src/lib/events/*` | every state change → `TimelineEvent` + bus → SSE |
| Audit | `AuditLog` via `audit()` | consequential actions (approvals, connects, settings) |
| Office | `src/components/office`, `src/lib/office` | [office-experience.md](office-experience.md) |
| Background work | none (request-driven) | bounded idempotent ticks with leases; see below |

## Durability model

There is no separate worker. Long work is broken into bounded steps:
`tickProduct` (product), `advanceMission` (mission), `runCheck` (sandbox).
Each step claims a lease (compare-and-set on a timestamp) so concurrent calls
don't double-execute; an expired lease after a crash is taken over and the
abandoned attempt is recorded as `worker_lost`. All authoritative state is in
the database — refreshing the browser or restarting the server loses nothing
but in-flight sandbox commands, whose results are discarded.

## Data model (product factory additions)

`Product` · `ProductBrief` (versions) · `BacklogItem` (EPIC/STORY/TASK/REPAIR,
unique `(productId,key)`) · `ProductArtifact` (DESIGN, HANDOFF, ARCHITECTURE,
RELEASE_CANDIDATE, DEPLOYMENT; versioned) · `LifecycleTransition` ·
`ProductApproval` · `RepoConnection` (unique `(companyId,provider,name)`;
stores env var **names**) · `GitOperation` (unique idempotency key) ·
`WebhookDelivery` (unique `(provider,deliveryId)`). Executions reuse
`Mission`, `MissionTask`, `MissionTaskRun`, `MissionArtifact`,
`MissionFinding`. Schema: `prisma/schema.prisma`; applied with
`npm run db:push` (no migration files — see [architecture/database.md](architecture/database.md)).

## Errors and observability

Domain errors extend `ApiError` (status-coded, safe message);
`handler()` maps them, logs unexpected ones and returns 500 without stack
traces. git errors redact auth headers. AURA's own health is evaluated by
deterministic rules in `src/lib/ops` (operations center).

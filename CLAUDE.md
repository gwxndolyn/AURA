# CLAUDE.md — AURA developer operating manual

> Primary instructions for Claude Code (and humans) working in this repository.
> Read this first. Load the linked docs/skills **only when a task needs them** —
> do not pull the whole library into every task.

## A. What AURA is

AURA is an **AI product engineering workspace**. A user describes a product or
change; specialised agents (PM, designer, architect, frontend/backend
engineers, QA, reviewer, security, DevOps) plan it, design it, build it in a
real git repository, verify it with real tests in the Docker sandbox, repair
failures within limits and prepare a release the user approves. The living
pixel-art office is a **view** of that persisted work. Product vision:
[docs/product-vision.md](docs/product-vision.md) · ledger:
[docs/implementation-status.md](docs/implementation-status.md).

**Honesty rules for this codebase:** work is VERIFIED only from executed
evidence; template/simulated-candidate/demo/not-run states are labelled; never
claim a deploy, PR or test result that did not happen.

The repo also contains AURA's **earlier company simulator** (sim clock, cyber
range, simulated deploy pipeline, company twin). Those surfaces are
demo/simulation only: their financial, customer and security data is
fictional, and the red team only ever targets in-process toy targets — never a
real system. See [SECURITY.md](SECURITY.md).

### Capability status (verified against code — keep honest)

| Capability | Status | Where |
|---|---|---|
| Agent orchestration (1 turn: context → model → run record → memory → events) | **Implemented** | `src/lib/agents/orchestrator.ts` |
| Central Claude abstraction + model router (FAST/STANDARD/REASONING) | **Implemented** | `src/lib/ai/claude.ts` |
| Offline simulation engine (no API key → deterministic structured JSON) | **Implemented** | `src/lib/ai/simulator.ts` |
| Real Docker code-execution sandbox (code → `node --test` in locked container) | **Implemented, Docker-gated** | `src/lib/sandbox/*` |
| Per-role agent tool permissions + audited tool runner | **Implemented** | `src/lib/agents/permissions.ts`, `tools.ts` |
| Multi-tenant auth + workspace isolation (choke point) | **Implemented** | `src/lib/auth/*` |
| Budget guardrails (daily hard-stop, loop guard) | **Implemented** | `src/lib/agents/guardrails.ts`, `src/lib/ai/budget.ts` |
| Deployment pipeline (legacy company simulator) | **Simulated** (deterministic stages; nothing ships to a real host) | `src/lib/workflows/deploy.ts` |
| Product deployment (V7: docker-host provider, preflight, approval-gated release engineer via `callTool("deploy.run")`, HTTP verification of the deployed URL, automatic rollback, history) + follow-up change requests on existing code + delivery scorecard | **Implemented**, verified with real containers; managed cloud providers not integrated; model provider was a test double | `src/lib/deploy/*`, `src/lib/factory/{change,base,scorecard}.ts`, [docs](docs/operations/product-delivery.md) |
| Cyber range attacks | **Simulated** against in-process toy targets | `src/lib/workflows/security.ts` |
| Realtime (in-process event bus + SSE) | **Implemented** | `src/lib/events/*`, `/api/companies/[id]/stream` |
| AI Engineering Intelligence (evals, prompt registry, experiments, gates, scorecards) | **Implemented**; live-provider evals unverified; routing advisory | `src/lib/intelligence/*`, [docs](docs/ai-engineering/intelligence.md) |
| Missions (plan → leased steps → sandbox-verified tests → human gate → report) | **Implemented**; code tasks only on bundled fixture repos | `src/lib/missions/*`, [docs](docs/architecture/missions-and-demo.md) |
| Multi-agent collaboration (capability registry, validated handoffs, budgeted context, evidence-backed review, bounded repair, timeline) | **Implemented**; live-model path unverified (no API key in CI) | `src/lib/agents/capabilities.ts`, `src/lib/missions/executor.ts`, [docs](docs/architecture/multi-agent-collaboration.md) |
| Per-user demo workspace + scoped reset + guided tour | **Implemented** | `src/lib/demo/service.ts`, `src/lib/onboarding.ts` |
| Development workspace (CodeMirror editor, project history, agent change review/accept/revert, sandbox checks) | **Implemented**; agent edits only on fixture modules; preview **not available** | `src/lib/devspace/*`, [docs](docs/architecture/development-workspace.md) |
| Commercial product: strict AI provider (no simulated output outside the lab), durable jobs + worker, real engineering runs (`src/lib/builder`), GitHub App, Stripe billing + entitlements + quotas, email, account deletion, marketing site | **Implemented**; live Anthropic/Stripe/GitHub untested here (HTTP test doubles in `test/doubles/`); Node.js projects only | `src/lib/{builder,jobs,billing,integrations,email}`, [docs](docs/implementation-status.md) |
| Engineering intelligence (code index + change impact, evidence-driven defects with repeated-failure stop, project memory with provenance/staleness, requirement traceability + invalidation, product budgets, sandbox cancellation, orphan recovery, rollback of AURA commits, profile-based delivery gate + report) | **Implemented**; impact is file-level static analysis; browser verification of generated apps added in V10 (see agent team row) | `src/lib/builder/{intel,debug}.ts`, `src/lib/factory/{memory,gate,intel}.ts`, [docs](docs/architecture/engineering-intelligence.md) |
| Engineering lab (versioned benchmark suite with train/held-out splits run on the real pipeline functions, multi-dimensional scorecard, evidence-required experiments with accept/reject/approval rules, rejected-approach memory, durable resumable loop state, ADMIN controls, `npm run lab`) | **Implemented**; evaluates AURA's deterministic methods (gate, context, diagnosis, impact, recovery), not model quality; no background controller (loop advances via CLI/API/job) | `src/lib/lab/*`, [docs](docs/architecture/engineering-lab.md) |
| Autonomous runtime (durable queue with priorities/deps/deadlines/limits/checkpoints/event log, registered heart-beating workers, graceful shutdown, lease recovery, circuit breakers, scheduler, goal engine with modes + budgets, kill switch, lab cycles, isolated self-modification, Autopilot control plane, alerts, readiness, Dockerfile) | **Implemented**; verified with real worker processes + containers; live model provider untested (test double); multi-worker on PostgreSQL untested | `src/lib/jobs/*`, `src/lib/runtime/*`, [docs](docs/operations/autonomous-runtime.md) |
| Product factory (brief → backlog → design/architecture → missions → evidence-verified tasks → git branches → re-tested release candidate → approvals; webhooks) | **Implemented**; executable tasks only on codebases with a known test harness; GitHub/GitLab live untested; no deploy provider | `src/lib/factory/*`, [docs](docs/product-lifecycle.md) |
| Company twin (deterministic planning simulation: scenarios, what-if, compare; ops map from real data) | **Implemented**; simulation only, never mutates real work; adviser unverified live | `src/lib/twin/*`, [docs](docs/architecture/company-twin.md) |
| Commercial SaaS (V8): named permissions, invitations/seats, session revocation, CSRF, atomic quota reservations, idempotent usage ledger, spending caps, Stripe plan changes/invoices/ordered+retried webhooks, encrypted tenant secrets, audit categories, export/archive/retention/deletion | **Implemented**; verified against a Stripe test double; live Stripe/email untested | `src/lib/{auth,billing,security,lifecycle}`, [docs](docs/operations/commercial-saas.md) |
| Agent team (V9/V10): versioned prompt library, chief-orchestrator policy (risk, reviewers, gates, recovery, disagreements, context provenance), feature contracts, real-Chromium browser verification + repair, quality metrics, expense-tracker benchmark | **Implemented**; benchmark passes with a model test double; live model unverified | `src/lib/agents/prompts.ts`, `src/lib/builder/{orchestrator,browser}.ts`, `src/lib/factory/contract.ts`, [docs](docs/architecture/agent-team.md) |
| Learning from builds (V11): idempotent learning events, run outcomes, evidence-based failure attribution, task + negative memory, recipes with honest validation, feedback → criteria, controlled prompt optimization (simulation never promotes), engineering-intelligence workspace | **Implemented**; verified with a model test double; live-model optimization unverified | `src/lib/learning/*`, [docs](docs/architecture/learning.md) |
| Operational intelligence (deterministic health rules, findings, policy-enforced actions, monitor, briefing, in-app notifications) | **Implemented**; request-driven monitor (no server scheduler); AI summary unverified live | `src/lib/ops/*`, [docs](docs/architecture/operations-intelligence.md) |

Full map: [docs/architecture/repository-map.md](docs/architecture/repository-map.md).
Authoritative docs live in [`docs/`](docs/README.md).

## B. Tech stack & boundaries

Next.js 15 (App Router) · React 18 · TypeScript · Tailwind · Prisma + **SQLite by
default** (Postgres optional) · Zustand · Recharts · React Flow · Framer Motion ·
CodeMirror 6 · Anthropic SDK. One process — no separate backend; Redis/Postgres are optional
(docker-compose provided). Path alias: `@/*` → `src/*`.

**Architectural boundaries you must respect:**
- All model calls go through `src/lib/ai/claude.ts`. Never `new Anthropic()` elsewhere.
- All agent tool calls go through `callTool()` in `src/lib/agents/tools.ts` (it enforces `toolSpecs.ts`: schemas, write scope, timeouts, approvals).
- Customer-facing model calls are strict (`ProviderError`, never simulator output); the simulator is only for the simulation lab (`AURA_SIMULATION_LAB=1`) and tests. Test doubles/fixtures live in `test/` and must never be imported by `src/` (guarded by `src/lib/no-fixtures.test.ts`).
- Long work runs as durable jobs (`src/lib/jobs`), never inside a request.
- All git operations go through `src/lib/factory/git.ts` (execFile, isolated config, token via env header — never in argv/URLs/logs).
- Backlog items reach `VERIFIED` only from mission evidence (`setItemStatus` with an engine actor + `verified: true`); people may only accept *non-executable* work as `DONE_UNVERIFIED`.
- All company-scoped data access is gated by `requireWorkspaceAccess()` / `requirePermission()` in `src/lib/auth/authz.ts`.
- Run quotas are taken with `reserve()`/`settle()` in `src/lib/billing/entitlements.ts` (atomic); never check-then-act on usage.
- Agent prompts live in `src/lib/agents/prompts.ts`; bump `PROMPT_LIBRARY_VERSION` when changing them.
- All API responses use the `ok`/`err`/`handler`/`parseBody` helpers in `src/lib/api.ts`.
- All realtime goes through `emitEvent()` (`src/lib/events/emit.ts`), not ad-hoc writes.
- Enum-like values are **strings** validated in app code — see `src/lib/types.ts` (SQLite has no enums).

## C. Repository navigation (real paths)

- **Frontend pages**: `src/app/` — landing `page.tsx`, `onboarding/`, app shell `app/[id]/` + per-feature pages (agents, code, cyber-range, analytics, …).
- **UI components**: `src/components/` (shell, dashboard, ui, cyber, agents, company, landing).
- **API handlers**: `src/app/api/**/route.ts` (41 routes). Conventions: [docs/architecture/api-design.md](docs/architecture/api-design.md).
- **Development workspace**: `src/lib/devspace/` (paths, files, changes, checks); UI `src/app/app/[id]/code`.
- **Operations**: `src/lib/ops/` (rules, snapshot, reconcile, actions/policy, monitor, briefing, notify).
- **Missions**: `src/lib/missions/` (state, graph, planner, engine, executor, context, repos, timeline, report). Demo: `src/lib/demo/`.
- **Product lifecycle**: `src/lib/factory/` (lifecycle, policy, brief, design, artifacts, scheduler, git, release, webhooks, read); UI `src/app/app/[id]/products`.
- **Business logic / workflows**: `src/lib/workflows/` (plan, executeTask, deploy, security, selfHeal, sprint, prioritize, reassign, conflict, approval, stressTest, build, decide).
- **AI provider adapter**: `src/lib/ai/` (claude, simulator, pricing, budget).
- **AI intelligence layer**: `src/lib/intelligence/` (evaluation, harness, datasets, registry, experiments, gates, scorecard, routing, knowledge, skillAudit). Agent turns record `AgentRun.promptRef`.
- **Agents**: `src/lib/agents/` (definitions = identity/prompt, capabilities = what each agent may do, contracts = output schemas, permissions, tools + toolSpecs, orchestrator, memory, guardrails, messaging).
- **DB models**: `prisma/schema.prisma`; client via `src/lib/db.ts`.
- **Security enforcement**: `src/lib/auth/` (authz, session, edge, password, service, rateLimit), `middleware.ts`, `src/lib/agents/permissions.ts`.
- **Realtime**: `src/lib/events/` + `src/hooks/`.
- **Sandbox**: `src/lib/sandbox/` (docker, runner, codegen).
- **Tests**: co-located `*.test.ts` (Vitest) + `e2e/journey.spec.ts` (Playwright).
- **Config**: `package.json`, `next.config.mjs`, `tsconfig.json`, `vitest.config.ts`, `playwright.config.ts`, `.env.example`, `docker-compose.yml`.

The 14 agent keys (role allowlists in `permissions.ts`): `ceo`, `product-manager`, `designer`,
`architect`, `frontend-engineer`, `backend-engineer`, `qa-engineer`, `reviewer`, `devops`,
`security-engineer`, `red-team`, `blue-team`, `data-analyst`, `support`.

## D. Required development workflow

Before implementing, in order:
1. Read the relevant doc(s) under `docs/` and this file.
2. Inspect the existing implementation (grep for the feature; don't assume).
3. Trace the request through its layers (route → authz → workflow/lib → prisma → event).
4. Identify reusable services (don't re-implement auth, events, tool runner, AI client).
5. Identify security & data implications (tenant scope, permissions, untrusted input).
6. Make a minimal plan (smallest complete vertical slice).
7. Implement.
8. Add/update tests (co-located `*.test.ts`; e2e if a user journey changed).
9. Run the relevant validation (`npm run typecheck`, `npm run lint`, `npm test`).
10. Update docs when you changed a contract (see [maintenance policy](docs/README.md#maintenance)).
11. Report what you **actually ran and verified** — not what you assume passes.

Pick the matching **skill** (`.claude/skills/`) — it encodes this per task type.
See the skill catalog in [docs/README.md](docs/README.md#skills).

## E. Non-negotiable engineering rules

- Do **not** duplicate existing functionality; reuse the service layers in §B.
- Do **not** bypass `claude.ts`, `callTool`, `requireWorkspaceAccess`, or the `api.ts` helpers.
- Do **not** add dependencies without a clear need (installs are fragile here — see §G).
- Do **not** hardcode secrets. `ANTHROPIC_API_KEY` is server-only; never ship it to the client.
- Do **not** trust AI output: validate/parse with Zod or `parseJSON` before use.
- Do **not** rely on frontend authorization. The backend `requireWorkspaceAccess` is the authority.
- Do **not** bypass tenant isolation — always scope queries by `companyId`; use `findFirst({ id, companyId })` for nested IDs (prevents IDOR).
- Do **not** execute untrusted/generated code outside the Docker sandbox (`src/lib/sandbox/`).
- Do **not** widen an agent's tool allowlist just to make a task easier.
- Do **not** hide failures behind fallback "success". The sandbox fallback is *flagged* (`real: false`), not disguised.
- Do **not** replace real behavior with mocks to make tests pass; do **not** claim tests passed unless you executed them.
- Do **not** introduce breaking changes without documenting them.
- Do **not** `rm -rf .next` or build into the OneDrive-synced folder — see §G.

## F. Definition of done

Every meaningful change ships with: implementation · tests (and you ran them) ·
error handling via `ApiError`/`AuthError` · security considerations (scope +
permissions) · logging/events where state changes · docs updated for changed
contracts · a verification note of what you actually ran. Full checklist:
[docs/engineering/definition-of-done.md](docs/engineering/definition-of-done.md).

## G. Environment gotchas (this machine)

- **OneDrive-synced repo.** Always run dev/build/e2e with `AURA_DIST_DIR=/tmp/aura-next`
  (honored by `next.config.mjs`). Never run plain `npm run dev`/`build` here, and
  never `rm -rf .next` into the synced folder — it triggers a Files-On-Demand
  eviction storm (hangs, `ETIMEDOUT`, load average 20–40). Recovery steps:
  [docs/getting-started/troubleshooting.md](docs/getting-started/troubleshooting.md).
- `tsx` (used by `db:seed`) and Playwright browser installs need the sandbox
  disabled on this box (IPC/cache paths). Builds can take 10+ min during sync churn.
- Default run needs **no** API key, **no** Docker, **no** Redis/Postgres — all
  optional, each with a flagged fallback.

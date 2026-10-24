# Autonomous product factory — gap analysis (2026-10-20)

Audit of the repository **before** the product-factory work, verified against
the code (not earlier docs). Classification:
**Verified** = implemented and covered by tests that were run ·
**Unverified** = implemented, no test exercising it ·
**Partial** · **Demo/UI-only** · **Missing**.

## Initial state

| Capability | Status before | Evidence |
|---|---|---|
| Routes / layout | Verified | `src/app/app/[id]/*` (overview, missions, operations, code, twin, …), 50 Prisma models, ~60 API routes |
| Auth + tenant isolation | Verified | `requireWorkspaceAccess`, middleware, IDOR tests in every `*.api.test.ts` |
| AI provider | Verified (simulation) / Unverified (live) | `src/lib/ai/claude.ts`; no key in CI, so live calls are never exercised |
| Agent registry + permissions | Verified | `definitions.ts`, `capabilities.ts`, `permissions.ts` (role allowlists enforced in `callTool`) |
| Durable missions / tasks / runs / leases | Verified | `src/lib/missions/*` (state machine, leases, `worker_lost` recovery, bounded repairs, approvals with payload hashes) |
| Real code execution | Verified (Docker) | `src/lib/sandbox/*` (`--network none`, limits); `node --test` only |
| Diffs, review, accept/revert | Verified | `src/lib/devspace/*`, CodeMirror `/code` |
| Executable codebases | **Partial** | only fixture apps in `src/lib/missions/repos.ts`; arbitrary repositories cannot be executed |
| Product brief / backlog / epics / stories | **Missing** | missions had flat task plans; the legacy `Project/Sprint/Task` models belong to the simulator |
| Lifecycle phases + transitions | **Missing** | |
| Designer agent / design artifacts / handoff | **Missing** | no designer role |
| Architecture artifacts | Partial | ARCHITECTURE mission task (text output) only |
| Git integration | **Missing** | no git, GitHub or GitLab code |
| Webhooks / CI events | **Missing** | |
| Release readiness | **Missing** | |
| Deployment | **Demo-only** | `workflows/deploy.ts` is a deterministic simulated pipeline; nothing ships |
| Production telemetry / incidents | Demo-only | incidents are cyber-range simulations; ops monitor watches AURA's own state |
| Autonomy levels | Partial | company `autonomy` field drives the simulator only |
| 3D office | Missing (before this work) | 2D React Flow cyber-range only |

## Most important gaps (by dependency)

1. No product-level state above missions (brief, backlog hierarchy, lifecycle).
2. Missions could not be dispatched *from* planned work with dependencies,
   and their outcomes did not flow back into a plan.
3. No version control: verified work was only "accepted" into an in-DB file store.
4. No release step that re-verifies integrated work, and no honest deployment state.
5. No design capability.

## What was implemented (this pass)

See [implementation-status.md](implementation-status.md) for the ledger. In
short: `src/lib/factory/*` adds the product lifecycle (Product, ProductBrief,
BacklogItem, ProductArtifact, LifecycleTransition, ProductApproval,
RepoConnection, GitOperation, WebhookDelivery), a PM brief/backlog generator
(model with schema validation, deterministic labelled template without a key),
a real **designer** agent and design artifacts with a visual wireframe review
loop and structured handoff, an architect artifact derived from inspected
code, a dependency-aware scheduler that dispatches **real missions** and maps
their persisted evidence back to backlog status (repairs, bounds, blocking),
a real git layer (local bare repositories, isolated branches, GitHub/GitLab
push + PR/MR through env-named credentials), webhook verification and
idempotency, release readiness, an integrated release candidate re-tested in
the sandbox, approval gates per action class, and the control centre UI.

## Deliberate deviations from the requested order

- **Repository execution stays fixture-backed.** Running arbitrary cloned
  repositories needs dependency installation with network access inside the
  sandbox, which the current sandbox forbids (`--network none`). Rather than
  weaken that, executable tasks are limited to codebases with a known test
  harness; everything else is honestly **not executable** and blocked.
- **No product deployment provider.** None is configured in this environment;
  the deployment request records exactly what is missing and is never shown
  as deployed.
- **No server scheduler.** Consistent with the existing request-driven design
  (missions, ops monitor), the product scheduler runs in bounded, idempotent
  ticks triggered by the UI/API. Leases make overlapping ticks safe and
  recover from crashes.

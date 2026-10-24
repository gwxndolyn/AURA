# Implementation status ledger

The recovery point for continuing work. Each row says where the code is, what
was **actually run** to verify it, and what is missing. Last update: 2026-10-23 (V7 product delivery).

Status: **Verified** (tests run and passing) · **Implemented, unverified** ·
**Partial** · **Blocked** (needs credentials/infrastructure) · **Not implemented**.

## Product delivery — AURA V7 (2026-10-23)

Guide: [operations/product-delivery.md](operations/product-delivery.md).

| Requirement | Location | Status | Verification performed | Limitations | Next action |
|---|---|---|---|---|---|
| Real deployment provider + connection check | `deploy/providers.ts` (`docker-host`) | Verified | journey.test (real containers), e2e product.spec | Local/remote Docker engine only | Add a managed provider when credentials exist |
| Release policy, preflight, approval-gated release engineer | `deploy/service.ts`, `release.ts` approvals, `callTool("deploy.run")` | Verified | journey.test (403 for MEMBER, nothing runs before approval, audited tool call) | — | — |
| Post-deploy verification + automatic rollback | `deploy/verify.ts`, `service.ts` | Verified | journey.test rollback case | HTTP checks, not browser automation | Playwright journeys against deployments |
| Follow-up change requests on existing code | `factory/change.ts`, `factory/base.ts` | Verified (model double) | journey.test 11–12; e2e plans C1 | Model quality untested live | Live key |
| Delivery scorecard | `factory/scorecard.ts` | Verified | journey.test assertions | — | — |
| Customer workspace (Deploy / Changes / Quality tabs) | `components/products/delivery.tsx` | Verified | e2e product.spec (browser) | — | — |

## Autonomous runtime — AURA V6 (2026-10-23)

Ops guide: [operations/autonomous-runtime.md](operations/autonomous-runtime.md).

| Requirement | Location | Status | Verification performed | Limitations | Next action |
|---|---|---|---|---|---|
| Durable jobs: claim CAS, priorities, deps, deadlines, timeouts, concurrency limits, backoff+jitter, event log, checkpoints | `jobs/queue.ts` | Verified | `runtime.test.ts` | DB polling (no push notification) | — |
| Workers: registration, heartbeats, lease recovery, cancel, graceful drain | `jobs/worker.ts`, `scripts/worker.ts`, `scripts/docker-entrypoint.sh` | Verified | unit + `acceptance-runtime.ts` (SIGKILL/reclaim) + container stop | SQLite = single writer; use Postgres for many workers | Verify multi-worker on Postgres |
| Scheduler (every / cron / once), single fire per slot | `runtime/schedule.ts` | Verified | concurrent-tick test | UTC only | — |
| Goal engine + modes + budgets + kill switch | `runtime/goals.ts`, runtime API | Verified (model double) | unit + acceptance (goal COMPLETED after crash) | PRODUCTION_OPS has no goal kinds (no prod provider) | Live key run |
| Circuit breakers | `runtime/breaker.ts` | Verified | unit | — | — |
| Self-improvement cycles | `runtime/improve.ts`, `lab.cycle` | Verified | real job run | Only registered candidate methods; no model-written candidates yet | Wire model-proposed patches into selfmod |
| Isolated self-modification + rollback | `runtime/selfmod.ts`, `Dockerfile.selfmod` | Verified | unit + real run on an AURA clone (reverted / committed / refused) | Allow-list is narrow by design | — |
| Control plane + observability + alerts + readiness | `/app/[id]/autopilot`, `runtime/observe.ts`, `/api/health/ready` | Verified | `e2e/autopilot.spec.ts`, container readiness | In-app alerts only | External paging channel |
| Live model provider | — | **Blocked** (no key here) | acceptance used the HTTP test double | — | `AURA_ACCEPTANCE_LIVE=1 ANTHROPIC_API_KEY=… npx tsx scripts/acceptance-runtime.ts` |

## Engineering lab — AURA V5 (2026-10-23)

Design: [architecture/engineering-lab.md](architecture/engineering-lab.md).

| Requirement | Location | Status | Verification performed | Limitations | Next action |
|---|---|---|---|---|---|
| Persistent evaluation lab on the real pipeline | `lab/runner.ts`, `lab/benchmarks.ts` (suite 2026.10.23-6, 37 cases, train/held-out) | Verified | `lab.test.ts`, `benchmarks.test.ts`; real runs on Docker + host | Measures deterministic methods; model output is supplied by benchmarks | Add model-in-the-loop cases when a provider key is available |
| Multi-dimensional scorecard, no fabricated metrics | `lab/scorecard.ts` | Verified | unit + persisted runs | Customer experience, provider cost and journeys listed as not measured | — |
| Safe experiments (evidence, criteria, same conditions, accept/reject/inconclusive/approval, rejected-approach memory) | `lab/lab.ts` | Verified | `lab.test.ts` decision rules + end-to-end experiments | One experiment at a time per workspace | — |
| Durable, verified, resumable loop state | `LabState`, `verifyState` | Verified | `lab.test.ts` interruption case | No background controller | Schedule `npm run lab` from cron/CI |
| Control interface with server-side authz | `/api/companies/[id]/lab/*`, `/app/[id]/engineering-lab` | Verified (API) · UI built, not e2e-tested | `lab.test.ts` API RBAC + tenant checks; `next build` | — | e2e spec for the page |
| Improvement: context selection (graph) | `builder/intel.ts` | **Adopted** | experiments context-graph (host) + context-graph-docker | Lexical seeds | — |
| Improvement: failure classifier v3 (hangs) | `builder/debug.ts` | **Adopted** | experiment diagnose-v3 (docker) | — | — |
| Improvement: verification gate v3 | `builder/verdict.ts` | **Awaiting ADMIN approval** (not default) | gate-v3-from-v1 (docker): 12/12 vs 1/12 defective changes rejected, 0 false rejects; engine suite passes with `AURA_GATE_POLICY=v3` | Pattern rules; not semantic | Approve, then set `DEFAULT_GATE_POLICY = "v3"` |
| Critical regression suite | full Vitest suite | Verified | 357 passed, 2 skipped (docker-double file skips when real Docker works), with Docker running | — | — |

## Engineering intelligence — AURA V3 (2026-10-22)

Design: [architecture/engineering-intelligence.md](architecture/engineering-intelligence.md). Acceptance numbers refer to the V3 brief.

| Requirement | Location | Status | Verification performed | Limitations | Next action |
|---|---|---|---|---|---|
| 1–2 Request → persisted brief, requirements, acceptance; tasks traced to requirement ids | `factory/brief.ts` (`requirements`, `validateBacklog(brief)`), `store.ts` | Verified (model double) | `v3.test.ts` 1–2 | Live PM output unverified | Run with a real key |
| 3–4 Dependencies respected; independent tasks concurrent; shared files never overlap | `factory/scheduler.ts` | Verified | `v3.test.ts` 3–4 | File-level conflict detection only | — |
| 5 Relevant verified memory retrieved; assumptions labelled; stale never used | `factory/memory.ts`, `builder/engine.ts` (context) | Verified | `debug.test.ts` memory; `engine.double.test.ts` (memory written from a verified run) | Lexical relevance | — |
| 6 Requirement change invalidates downstream work | `store.ts` (`reviseBrief`), `CHANGE_SET` artifact | Verified | `v3.test.ts` 6; `factory.test.ts` | Untraced legacy products fall back to "flag all" | — |
| 7 Repository analysis finds relevant files/tests | `builder/intel.ts` (TS parser), `factory/intel.ts`, `/intel` route | Verified | `intel.test.ts`; `v3.test.ts` 16 (route) | File-level; requirement→files is lexical | Language-server symbol references |
| 8–9 Real failing test → defect; targeted fix verified by the real re-run | `builder/debug.ts`, `engine.ts` | Verified (host execution via docker-CLI double) · Docker path asserted in `builder.test.ts` but **not run here** | `debug.test.ts` (real `node --test` output); `engine.double.test.ts` journey 1 | Docker Desktop storage on this machine is corrupted (I/O errors), so the Docker journeys were skipped | Re-run `builder.test.ts` with working Docker |
| 10 Repeated failures stop within limits | `debug.ts` (`repeatDecision`), `engine.ts` (identical-tree stop) | Verified | `debug.test.ts`; `engine.double.test.ts` journey 2 (stops before `maxRepairs`) | — | — |
| 11 Interrupted work recovers | `builder/service.ts` (`recoverOrphanedBuilds`), queue leases | Verified | `v3.test.ts` 11; `builder.test.ts` lease reclaim | — | — |
| 12 Duplicate events → no duplicate side effects | `startBuild` idempotency, `runBuild` finished-run guard, `recordAttempt` per-attempt dedupe | Verified | `v3.test.ts` 12; `debug.test.ts` | — | — |
| 13 Existing user changes preserved (rollback) | `factory/git.ts` (`revertAuraCommits`), `release.ts` (`rollbackItem`) | Verified (real git) | `v3.test.ts` 13: a person's commit on the task branch survives; main untouched | Conflicting reverts are refused, not resolved | — |
| 14 Regression checks after code changes | `engine.ts` (focused impacted tests + full plan), `intel.ts` (`analyzeChange`) | Verified (host execution via double) | `engine.double.test.ts`; `intel.test.ts` | Focused runs only for `node --test` projects | Jest/Vitest file filters |
| 15 Quality gate prevents premature completion | `factory/gate.ts` (profiles) | Verified | `v3.test.ts` 15; `engine.double.test.ts` (verified task ≠ implemented) | Journeys always `not_verified` (no browser QA of generated apps) | Playwright QA of built apps |
| 16 Sensitive operations need the configured role | gate/memory/rollback routes | Verified | `v3.test.ts` 16 (VIEWER/MEMBER/ADMIN, cross-tenant 404) | — | — |
| 17 Cancellation propagates | `cancelBuild` (job + `docker kill` of `Build.container`), tool-loop checks | Verified for queued runs; container kill **not exercised** (no working Docker here) | `v3.test.ts` 17 | An agent turn in flight stops at its next check | Run with Docker |
| 18 Budgets prevent unbounded execution | `engine.ts` (`remainingFor`), `scheduler.ts` (`projectBudgetUsd`, 80 % alert) | Verified | `v3.test.ts` 18 | Costs are estimates (list prices) | — |
| 19 Frontend reflects backend state | Quality / Memory / Code / Defects tabs (`components/products/engineering.tsx`), SSE refresh | Implemented; e2e written (`e2e/v3.spec.ts`) — see verification note | see "Verification note" below | — | — |
| 20 Delivery report matches artifacts/results | `gate.ts` (`deliveryReport`) | Verified | `v3.test.ts` 15+20; `engine.double.test.ts` | — | — |

## Commercial product (2026-10-22)

| Requirement | Location | Status | Verification performed | Limitations | Next action |
|---|---|---|---|---|---|
| No simulated output in customer flows | `ai/claude.ts` (strict by default outside lab/test), `factory/brief.ts`, `design.ts`, `artifacts.ts` | Verified | builder/factory tests: provider outage → job DEAD, nothing fabricated; `no-fixtures.test.ts` guards imports + marketing copy | Simulator still used by the simulation lab (`AURA_SIMULATION_LAB=1`) | — |
| AI planning (PM brief + backlog), structured + validated, corrective retry | `factory/brief.ts`, job `product.plan` | Verified via provider test double | builder.test.ts journey 2; e2e product.spec | Live model quality unverified (no key here) | Run with a real key |
| Durable jobs (leases, retries/backoff, dead-letter, idempotent enqueue, cancel) | `src/lib/jobs/*`, `instrumentation.ts`, `scripts/worker.ts` | Verified | lease reclaim, dedupe, retry→DEAD tests | Single DB queue (fine to ~100s of jobs/min) | — |
| Real engineering runs: tool-using agents on a git working tree; engine-run install/test/lint/build in Docker; QA/security/review; bounded repair; commit | `src/lib/builder/*` | Verified (Docker) | builder.test.ts journeys 3–5 (real failing npm test → repair → 5/5 pass → commit); e2e product.spec (browser, real run) | Node.js projects only; no browser tests of generated UIs | Python/other runtimes; Playwright QA of built apps |
| Release integration by real `git merge` + re-verification | `builder/integrate.ts`, `factory/release.ts` | Implemented, unverified end to end since rewrite | — | — | Add a test with two verified branches |
| GitHub App: connect (signed state), list repos, link/import, push, PR (idempotent), PR status + checks, revoked handling, disconnect | `src/lib/integrations/github/*`, routes | Verified against GitHub API test double + real git push | github.test.ts | Live GitHub untested (no App credentials here) | Create the App, run once live |
| Billing: plans config, Stripe checkout/portal, signed webhooks (idempotent), entitlements + quotas, past_due/cancel handling | `src/lib/billing/*` | Verified (test mode, Stripe API double) | billing.test.ts; e2e product.spec | Live Stripe untested; seats not enforced yet | Configure Stripe test keys and run once |
| Usage metering (tokens, est. cost, sandbox ms, runs, products) + monthly AI budget stop | `billing/entitlements.ts`, builder | Verified | builder/billing tests | Cost is estimated at list prices | — |
| Auth: register/login/logout, password reset email flow, account deletion | `auth/*`, `email/send.ts`, pages | Implemented; reset UI unverified in e2e | unit (billing/auth suites) | Email needs Resend credentials | e2e for reset |
| Marketing site: landing, pricing, docs, security, terms, privacy | `src/app/{page,pricing,docs,security,terms,privacy}` | Verified | journey.spec (links 200), product.spec (CTA → signup → app) | Legal text is a template; operator must review | Legal review |
| Simulation lab gating (nav, pages→redirect, APIs→404, fake finance hidden) | `middleware.ts`, `lib/lab.ts`, nav/topbar | Implemented | e2e runs without the lab | — | — |

## Product lifecycle (product factory)

| Requirement | Location | Status | Verification performed | Limitations | Next action |
|---|---|---|---|---|---|
| Persisted lifecycle with explicit, reasoned phase transitions | `src/lib/factory/lifecycle.ts`, `store.ts` (`movePhase`), `LifecycleTransition` | Verified | `factory.test.ts` (edges, derivePhase, transitions recorded with actor+reason) | Phase is derived from backlog state on each tick; release phases only via release actions | — |
| PM brief + revisions | `factory/brief.ts`, `store.ts` (`reviseBrief`) | Verified (template) · Unverified (model) | schema, revision conflict (409), requirement change re-opens scope + flags items | Live PM output untested (no API key in CI) | Run with a key; add eval dataset |
| Backlog Epic → Story → Task → Repair, dependencies, estimates | `BacklogItem`, `brief.ts` (`templateBacklog`, `validateBacklog`) | Verified | acyclic graph, ≤12 tasks, acceptance + verifyBy on every task | Template backlog is specific to matching/discovery ideas | Broaden templates; model refinement loop |
| Designer agent, design spec, visual review, revisions, handoff | `agents/definitions.ts` (`designer`), `factory/design.ts`, `artifacts.ts`, UI Design tab | Verified (template) | revise → v2, approve → HANDOFF with consumers; e2e screenshots | Wireframe preview is generated from the spec, not a rendered app page | Render designs as real preview routes |
| Architecture artifact from inspected code | `artifacts.ts` (`produceArchitecture`) | Verified (template) | e2e + unit | Live architect output unverified | — |
| Dependency-aware scheduling, file-conflict avoidance, parallel limit | `factory/scheduler.ts` | Verified | readyKeys/cycle tests; e2e dispatch only after deps settle | Request-driven ticks (no background worker) | Optional server worker (instrumentation) |
| Real execution via missions (sandbox tests, review probes, bounded repairs) | reuses `missions/*`, `devspace/changes.ts` | Verified (Docker) | `factory.test.ts` 7–11: first fix fails reviewer probes, repaired, final tests 4/4 in Docker | Code edits in simulation mode are the fixture's prepared candidates, labelled `simulated-candidate` | Live model edits on real repos |
| Evidence-only VERIFIED; unverifiable work never "done" | `lifecycle.ts` (`assertItemMove`) | Verified | unit + API (409 on person-set VERIFIED / DONE_UNVERIFIED for executable) | — | — |
| Repair routing + escalation | `scheduler.ts` (`routeFailure`) | Implemented, partially verified | repair item creation path; in-mission repair verified; product-level REPAIR dispatch not exercised by a test | — | Add a test with a fault that exhausts in-mission repairs |
| Pause / resume / cancel propagation | `scheduler.ts` (`controlProduct`) | Verified | unit (pause blocks ticks; cancel closes approvals) | A sandbox command already running finishes; its result is discarded | — |
| Crash recovery | product tick lease + mission leases | Verified | expired lease taken over (unit); mission `worker_lost` recovery tested in `missions.test.ts` | — | — |
| Autonomy levels + action-class approval policy | `factory/policy.ts`, `approvals/[approvalId]` route | Verified | unit; API RBAC (publication/production ADMIN+) | — | — |
| Real git: per-product repo, isolated branches, base-move detection | `factory/git.ts` | Verified | real git in tests; e2e diff view | Repos live under `AURA_GIT_ROOT` on the app server | Persistent volume in prod |
| GitHub/GitLab push + PR/MR | `git.ts` (`pushBranch`, `openChangeRequest`) | Verified against a local bare remote + mocked REST API · **Blocked** live | push to bare remote; PR idempotency with mock fetch | No live GitHub/GitLab credentials here | Verify with a repo-scoped token |
| Webhooks: HMAC/token verification, idempotency, opt-in triggers | `factory/webhooks.ts`, `/api/webhooks/[provider]` | Verified | unit + API (401 unsigned, duplicate ignored, push off by default) | No live provider delivery tested | — |
| Release readiness (passed / failed / not run / n/a) | `factory/release.ts` (`readiness`) | Verified | unit + e2e | Several checks are honestly `not_run` (deploy target, monitoring) | — |
| Release candidate re-tested on integrated branch | `release.ts` (`createReleaseCandidate`) | Verified (Docker) | unit + e2e (4/4 in Docker) | Integration is file-level (latest verified content), no 3-way merge | Real merge with conflict surfacing |
| Production deployment (superseded by V7 `deploy/*`) | `release.ts` (`requestDeployment`) | Superseded | approval required; result `NOT_DEPLOYED` and missing setup listed | No deployment provider adapter is configured | Add a provider adapter (e.g. container host) |
| Production telemetry → incidents | — | Not implemented | — | AURA does not invent production signals | Connect a telemetry provider |
| Control centre UI | `src/app/app/[id]/products/*` | Verified | `e2e/factory.spec.ts` (1440×900 + 390×844 screenshots reviewed) | — | — |

## Existing subsystems (unchanged in this pass unless noted)

| Capability | Status | Notes |
|---|---|---|
| Missions engine (plan → execute → verify → repair → report) | Verified | `missions.test.ts`, `collaboration.test.ts` |
| Development workspace (editor, diffs, accept/revert, sandbox checks) | Verified | `devspace.test.ts`, `e2e/devspace.spec.ts` |
| Operational intelligence (AURA's own health) | Verified | `ops.test.ts`, `e2e/operations.spec.ts` |
| Company twin (planning simulation) | Verified | secondary planning tool; never mutates real work |
| Legacy company simulator (sim clock, cyber range, simulated deploy pipeline) | Demo-only | clearly labelled; not part of the product lifecycle |
| Living 3D office (live page + landing demo) | Verified | `office.test.ts`, `office.api.test.ts`, `e2e/office.spec.ts` (3D under SwiftShader only; 2D fallback; mobile). See [office-experience.md](office-experience.md) |
| Landing guided demo | Verified (demo) | scripted replay; plan/diffs/fixtures asserted against real code; test results recorded from real Docker runs ([demo-mode.md](demo-mode.md)) |
| Live AI provider | Unverified | no API key in CI |

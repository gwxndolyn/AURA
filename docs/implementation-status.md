# Implementation status ledger

The recovery point for continuing work. Each row says where the code is, what
was **actually run** to verify it, and what is missing. Last update: 2026-10-24 (V8 commercial SaaS, V9 agent team, V10 product craft, V11 learning).

Status: **Verified** (tests run and passing) · **Implemented, unverified** ·
**Partial** · **Blocked** (needs credentials/infrastructure) · **Not implemented**.

## Learning from builds — AURA V11 (2026-10-24)

Design: [architecture/learning.md](architecture/learning.md).

| Requirement | Location | Status | Verification performed | Limitations | Next action |
|---|---|---|---|---|---|
| Outcome-linked records per run (prompt refs, models, files, executed tests, criteria, findings, defects, attempts, outcome class) | `learning/service.ts` `RunOutcome` | Verified | eval scenario 12; V10 benchmark (3 runs, 4/4 tests executed) | Model config = model id only | — |
| Idempotent durable learning events, crash-safe processing | `LearningEvent`, `processPending`, worker maintenance, `learning.process` job | Verified | eval 12 (duplicate emit no-op, claimed-but-unprocessed event retried) | Polling, no push | — |
| Scoped memory: project (existing), task (`Build.taskMemory`, resumed), reusable recipes, agent performance, user feedback | `factory/memory.ts`, engine, `learning/*` | Verified | eval 1–4, 7–9; benchmark asserts task memory | Reusable knowledge is authored/discovered recipes, not free text | Discover recipes from repeated defect solutions |
| Evidence-based failure attribution (taxonomy, scope, root cause vs symptoms, confidence, UNKNOWN, fix verification) | `learning/attribution.ts` (rules `attr-1`) | Verified | eval 5 (8/8 labelled cases), 6, 7; benchmark: browser defect → `architecture_contract`, fix VERIFIED | Rule-based; no model-assisted investigation | Model-assisted hypothesis ranking, evaluated |
| Recipes with applicability + honest validation | `learning/recipes.ts` | Verified | eval 4; benchmark: recipes offered and outcomes recorded | 7 authored recipes, all UNVALIDATED at start | Accumulate applications |
| Retrieval with precedence, negative knowledge, stale/missing-file exclusion, manifest | `learning/retrieval.ts`, engine | Verified | eval 1–3, 7–9; run view shows manifest | Lexical relevance (no embeddings) | Measure precision on real runs |
| Agent performance with explicit denominators/exclusions | `agentPerformance` | Verified | eval 12 | — | — |
| Controlled optimization: problems → bounded DRAFT → A/B → gated promotion → rollback; simulated evidence cannot promote; per-category regression rejects lab candidates | `learning/optimize.ts`, `intelligence/experiments.ts`, `lab/lab.ts` | Verified | eval 10, 11; intelligence workflow test (simulated promotion blocked) | **No live-model A/B run** (no key) | Run `evaluate` with a live key, ≥ 3 repetitions |
| User feedback → criteria / instructions / browser / scope / reviewer actions; editable; scoped | `learning/feedback.ts`, routes, run view, workspace | Verified | eval 9; commercial suite (authz, isolation, CRUD) | Rule-based classification | — |
| Engineering-intelligence workspace | `/app/[id]/learning`, `/api/companies/[id]/learning/*` | Verified | commercial suite (API); `e2e/learning.spec.ts` (real browser: empty states, feedback actions shown, disable/delete, settings members/usage/secrets/security tabs, audit entries) | Populated-state UI covered by API tests only | — |
| Lifecycle events plan.approved / delivered | `factory/release.ts`, `deploy/service.ts` | Implemented | typecheck; emitted on scope approval and verified deployment | Not yet consumed by a handler (recorded for timelines) | Delivery outcome on RunOutcome |
| Delivery independent of learning | emit/retrieval failure-tolerant | Verified | commercial suite (store down → build continues) | — | — |

## Product craft + agent team — AURA V9/V10 (2026-10-24)

Design: [architecture/agent-team.md](architecture/agent-team.md).

| Requirement | Location | Status | Verification performed | Limitations | Next action |
|---|---|---|---|---|---|
| Operational prompt library (role cards + engineering/security rules), versioned, recorded per run | `agents/prompts.ts`, `definitions.ts`, `intelligence/registry.ts` | Verified | `orchestrator.test.ts` (all sections present, rules attached, verdict contract); benchmark asserts PM runs carry `@2026.10.24-2` | Prompt quality vs a live model unmeasured | Run the lab/eval with a live key; promote DRAFT versions on evidence |
| Planning calls recorded as AgentRuns with promptRef (PM, designer, architect, change) | `factory/brief.ts` `structured()` | Verified | benchmark test 1; factory suites | — | — |
| Chief-orchestrator policy: risk, review plan, gate per risk, inputs, recovery, disagreements, context provenance | `builder/orchestrator.ts`, `engine.ts` | Verified | `orchestrator.test.ts` (12); benchmark records `Build.orchestration` | Risk detection is lexical | — |
| Handoff validation (no FRONTEND work without approved design; no dependant without architecture) | `scheduler.ts` + `missingInputs` | Verified (unit) | `orchestrator.test.ts` | Not exercised in an e2e with a DESIGN task | Add to benchmark |
| Dependent tasks build on verified dependency branches | `engine.ts` | Verified | benchmark: frontend branch contains the verified API | Conflicts block (not auto-resolved) | — |
| Browser verification (isolated app container + real Chromium, 2 viewports, a11y/overflow/errors/requests, persistence journey, screenshots) | `builder/browser.ts`, engine | Verified | `browser.test.ts` (good app passes; persistence bug, unlabeled field, mobile overflow, crash-on-start found); benchmark | Heuristic journey (first form); no visual-diff baseline | Visual regression baselines |
| Browser-found defect → repair → re-verify | engine feedback + recovery | Verified | benchmark: attempt 1 tests pass, browser blocks (list not refreshed, unlabeled amount), attempt 2 verified | — | — |
| Feature contracts per story, versioned, change flags verified work | `factory/contract.ts`, scheduler | Implemented, partially verified | contract injected into context in the benchmark (`contextManifest` has `contract`) | Contract-change flagging not covered by a test | Test a brief revision |
| Quality metrics (journeys, browser clean, a11y, repair success, criteria met, unsupported claims) + browser gate criterion | `factory/scorecard.ts`, `gate.ts` | Verified | benchmark asserts values | Visual design quality not measured | — |
| Office shows real build turns (implementing / verifying / reviewing) | `office/live.ts`, `state.ts` | Implemented | office suites pass | No dedicated test for run mapping | Add a unit test |
| V10 benchmark (expense tracker) | `factory/v10.benchmark.test.ts` | **Passed** (4/4, ~51 s) with model double | PM plan → API verified (QA+security+review) → UI fails in browser, repaired, verified at 2 viewports with persistence → RC re-tested → real container deploy → totals/filter/validation over HTTP → **persistence across container restart** → follow-up "delete" change verified, original tests re-run | Model provider is a test double; live model behaviour unverified | Run with a live key |
| Live model provider | — | **Blocked** (no key) | — | — | `ANTHROPIC_API_KEY` |

## Commercial SaaS — AURA V8 (2026-10-24)

Guide: [operations/commercial-saas.md](operations/commercial-saas.md).

| Requirement | Location | Status | Verification performed | Limitations | Next action |
|---|---|---|---|---|---|
| Tenant isolation on every resource kind (404), IDOR, background tenant scope | `auth/authz.ts`, routes, `builder/service.ts` | Verified | `commercial.test.ts` (14 resource kinds incl. downloads, deploy, export, jobs, SSE, screenshots) | — | — |
| Named permission model + role enforcement + denial audit | `authz.ts` `PERMISSIONS` | Verified | commercial suite | — | — |
| Invitations, seats, role changes, ownership transfer, removal | `auth/members.ts`, `/members/*`, `/invitations` | Verified | commercial suite (escalation refused, email-bound single-use, seat limit) | Email delivery needs Resend | Configure email |
| Session revocation (logout, password change/reset, sign-out-everywhere), enumeration-safe login, per-account limits, CSRF origin check, prod dev-secret guard | `auth/session.ts`, `edge.ts`, `csrf.ts`, auth routes | Verified | commercial suite | In-process rate limiter | Shared limiter for multi-instance |
| Email verification | `/api/auth/verify-email`, `/verify-email` | Verified (API) | commercial suite | UI not e2e-tested | e2e |
| Plans as data, annual prices, downgrade guard, plan change with proration, cancel/resume, server-side sync, invoices, ordered + retried webhooks | `config/plans.json`, `billing/*` | Verified (Stripe API double) | commercial suite | **Live Stripe unverified** | One test-mode run |
| Atomic quotas with reservations + recovery; spending cap | `billing/entitlements.ts` | Verified | 25 parallel → exactly 10; 6 parallel → 1 slot; release/settle/recover; cap stops a run | SQLite single writer | Postgres multi-worker test |
| Idempotent usage ledger (basis, model, period) + reconciliation | `entitlements.ts` | Verified | duplicate + concurrent writes counted once | — | — |
| Encrypted tenant secrets; deployment env only from tenant store; redaction (logs, audit, sandbox output, deploy logs) | `security/secrets.ts`, `redact.ts`, `deploy/service.ts` | Verified | commercial suite (AAD binding, server env never injected, redaction patterns) | Key rotation not implemented | Add key versions |
| Audit categories/outcomes, admin viewer | `events/emit.ts`, `/audit-log`, Settings → Security | Verified (API) | commercial suite | — | — |
| Export, archive/restore, retention purge, workspace/account deletion with honest retained-elsewhere list | `lifecycle/*`, routes | Verified | commercial suite | Retention purge not run in a test | Unit-test `runMaintenance` |
| Commercial alerts, readiness, production config validation, platform admin | `runtime/observe.ts`, `health/ready`, `runtime/config.ts`, `/api/admin/overview` | Verified | commercial suite | In-app alerts only | Paging channel |
| Settings UI: members, billing (monthly/annual, invoices, cancel), usage + cap, secrets, security/data, account security | `app/app/[id]/settings/page.tsx` | Implemented; `next build` passes | not e2e-tested | — | e2e spec |

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

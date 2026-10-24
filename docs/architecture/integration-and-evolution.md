# Integration intelligence (V13) and product evolution (V14)

Both phases extend the existing builder/factory pipeline; nothing runs beside it.

## V13 — integration, diagnosis, resilience

| Capability | Where | How it works |
|---|---|---|
| System dependency graph | `builder/graph.ts` | Built from the code index (TS-parsed imports, route tables, frontend `fetch`/`api(...)` calls incl. prefix + query calls, Prisma/SQL schema) plus source extraction (persistence calls, `process.env`, SDK imports, literal external hosts, timers/workers), traceability (requirement → verified/planned files) and **runtime** evidence (API requests the real browser made, journeys). Every edge has `basis` (runtime / static / inferred) + `source`. Persisted per commit in `SystemGraphSnapshot`. |
| Change impact | `graphImpact()` | changed files → dependents → routes they handle → pages calling those routes → entities, tests, requirements, journeys, contracts, with a confidence and its reasons. |
| Integration checks | `integrationFindings()` | Whole-app: missing route (with near-match suggestion), method mismatch, request-body fields vs handler fields, required env vars not provided by the target, runtime-observed broken calls. Confirmed findings on changed files block the attempt. |
| Investigation | `builder/diagnose.ts`, `builder/integration.ts` | Symptoms (failing tests, browser findings, contract findings) → competing hypotheses (configuration, external service, contract mismatch, backend 5xx, per-file code defect, test defect) scored by explained symptoms, directness and upstream position → root cause or **ambiguous** (top two not separated) or none. Persisted as `Investigation` (OPEN → REPAIRING → RESOLVED / UNRESOLVED, or LIMITATION). |
| Self-healing loop | `builder/engine.ts` | The diagnosis + smallest change is the first section of the repair brief; the same run is the single remediation (no duplicate tasks); repairs stay on the task branch; the full suite + browser + review gate decides; failed runs keep evidence and are not merged. |
| Infrastructure vs code | engine | When the most supported cause is unavailable configuration or an unreachable external service, the run stops `BLOCKED` with "not a code defect" — **no repair attempts are spent rewriting application code**; learning records it as `INFRA_FAILED`. |
| Test selection | `selectTests()` | Targeted tests from the graph run first (`focused_test`); the **full suite always runs as the gate**. The plan (selected tests, confidence, reasons) is stored on `Build.testSelection`. |
| Resilient provider HTTP | `resilience/http.ts` | Timeouts, cancellation, bounded retries with full jitter only for idempotent requests (or POST with `Idempotency-Key`), 429/5xx/network retried, other 4xx never, typed `ProviderHttpError`, optional persisted circuit breaker, malformed-JSON detection. Used by the Stripe and GitHub adapters. |
| Failure injection | `resilience/inject.ts` | timeout / 429 / 500 / malformed / network / slow / expired auth / flaky(n). Active **only** when `NODE_ENV=test` and `AURA_FAULT_INJECTION=1`; otherwise a no-op that throws if asked to activate. |
| Operational readiness | `factory/operations.ts` | health, readiness, timeouts on outbound calls, safe errors, structured logging, graceful shutdown, required config vs target, restart recovery, monitoring, backups — each passed/failed/warning/not_run with its evidence type. |
| Workspace | product → **Integration** tab | root causes grouped by origin, investigations with hypotheses, contracts, graph browser (by node kind, edges with basis), test selections, operational readiness. |

Existing pieces reused: durable job queue + leases (worker interruption), queue dead-letter/backoff,
`UsageReservation`/ledger idempotency (duplicate events), learning events (duplicate delivery),
deployment rollback, defect classifier, scheduler file-overlap serialization + dependency merges
(concurrent agents).

## V14 — product evolution and maintenance

| Capability | Where | How it works |
|---|---|---|
| Version-aware state | `factory/maintenance.ts` `versionState()` | workspace sha · verified release candidate · deployed (only from VERIFIED deployment records) · rollbacks · open work · verified capabilities. Never infers deployment from commits. |
| Proposals from evidence | `collectProposals()` | debt findings, confirmed integration findings, dependency review, failed/blocked tasks, non-blocking security findings, active user feedback, recurring failure attributions, explicit user requests. Deduplicated by fingerprint; proposals whose evidence disappeared become OBSOLETE; missing sources (analytics, monitoring, registry) are listed. |
| Prioritisation | `prioritize()` | qualitative benefit / uncertainty / effort / regression risk + requested; **mandatory** (security / data integrity) +100 and cannot be re-ranked below optional work; reasons stored (`priorityWhy`). |
| Technical debt | `factory/debt.ts` | import cycles, duplicated function bodies, long/deeply-nested functions, routes/persistence with no test, empty catch, internal errors leaked, broken contracts, unimported modules (marked subjective), env drift vs `.env.example`, I/O in loops. Each with evidence, consequence, small action and verification. No rewrites recommended. |
| Dependency review | `dependencyReview()` | lockfile, unbounded ranges, engines; registry and advisories reported **not_run** without network data; "newer version" alone is never a reason to upgrade. |
| Autonomy modes | `runCycle()` + `/evolution/policy` | OBSERVE and RECOMMEND execute nothing; IMPLEMENT_ISOLATED turns APPROVED proposals into maintenance tasks (normal isolated builder branches, no release); AUTONOMOUS additionally takes `approval: "policy"` (low-risk, non-sensitive) proposals. Sensitive proposals (auth, secrets, migrations, schema, deploy, mandatory) need an ADMIN approval in every mode. |
| Budgets & stability | `MaintenanceBudget` | changes per cycle, unreviewed changes, attempts per issue (then FAILED + escalation notification), concurrent cycles, cycle time; checkpoints persisted; crashed cycles resumed by the worker; cancellation honoured mid-cycle. |
| Outcomes | `settleProposals()` | DONE only from a VERIFIED task (no change → NO_CHANGE_NEEDED); failure returns the proposal to APPROVED with evidence; `objectiveMet` stays **unknown** until re-analysis no longer detects the problem (or `false` if it still does). Emits a learning event. |
| Requirement changes | existing `factory/change.ts` | targeted tasks on existing files with "Still works" criteria, feature-contract invalidation and graph-based regression selection. |
| Workspace | product → **Evolution** tab | version boxes, policy selector (admin), analyse / run cycle, prioritized proposals with evidence and reasoning, approve / no change / reject, own requests, cycles with cancel. |

## Benchmark (`src/lib/factory/v10.benchmark.test.ts`)

Real pipeline, model provider = test double, everything else real (git, Docker sandbox, Chromium, container deployment):
V10 build → V13 integration defect (client renamed a route) diagnosed as `contract_mismatch` in
`public/app.js`, repaired, verified in the browser, runtime edges in the graph → V13 missing
`FX_API_KEY` reported as infrastructure limitation with zero code-repair attempts → V14 approved
refactor run in IMPLEMENT_ISOLATED, behaviour preserved (original tests re-run), nothing released,
objective marked unknown.

# Engineering intelligence (V3): code index, impact, defects, memory, gate

How AURA understands a repository before changing it, debugs from evidence,
learns per project, and decides whether work is actually delivered. All of it
builds on the existing builder (`src/lib/builder`) and product factory
(`src/lib/factory`); there is no parallel engine.

| Concern | Code | Persisted as | API | UI tab |
|---|---|---|---|---|
| Code index + change impact | `builder/intel.ts`, `factory/intel.ts` | `CodeIndex` (per repo × commit), `Build.impact` | `GET …/products/[productId]/intel[?item=KEY]` | Code, Runs |
| Evidence-driven debugging | `builder/debug.ts`, `builder/engine.ts` | `Defect`, `Build.stopReason` | `GET …/defects` | Defects, Runs |
| Project memory | `factory/memory.ts` | `ProjectMemory` | `GET/PATCH …/memory` | Memory |
| Requirement traceability + invalidation | `factory/brief.ts`, `factory/store.ts` (`reviseBrief`) | `BacklogItem.requirements`, `CHANGE_SET` artifact | `PUT …/brief` | Brief, Backlog |
| Budgets + model routing | `builder/engine.ts` (`tierFor`, `remainingFor`), `factory/scheduler.ts` | `Build.budgetUsd`, `Product.limits.projectBudgetUsd`, `Notification(kind=budget)` | `PATCH …/products/[productId]` | Runs, notifications |
| Cancellation into the sandbox | `builder/service.ts` (`cancelBuild`), `builder/sandbox.ts` | `Build.container` | `POST …/builds/[buildId]` | Runs |
| Crash recovery | `builder/service.ts` (`recoverOrphanedBuilds`), called by every tick | `Build.status=BLOCKED` + reason | `POST …/tick` | Runs |
| Rollback of AURA changes | `factory/git.ts` (`revertAuraCommits`), `factory/release.ts` (`rollbackItem`) | `GitOperation(op=rollback)` | `POST …/items/[key]/rollback` | Backlog |
| Delivery quality gate + report | `factory/gate.ts` | `Product.qualityProfile`, `DELIVERY_REPORT` artifact | `GET/PATCH/POST …/gate` | Quality |

## Code index (what it is, and is not)

`buildIndex(files)` reads every source file of a snapshot:

- **imports** via the TypeScript compiler's pre-processor (`ts.preProcessFile`,
  which also detects `require()`), resolved to repository files the way
  Node/TS resolve relative specifiers; **symbols** from the TS parser's
  top-level declarations. If `typescript` is not installed on the server a
  regex scanner is used and `parser: "regex"` says so.
- **tests → files**: each test file's transitive local imports.
- **routes**: node-web route tables, Express/Fastify-style calls, Next.js
  app-router `route.ts` exports. **contracts**: frontend `fetch("/api/…")`.
- **schema**: Prisma models, SQL `CREATE TABLE`. **config**: package manager,
  scripts, dependencies, framework.

Limitations are returned with every index: no type checking, no cross-file
symbol resolution, no dynamic-import tracing — impact is **file-level**.
`relatedToText()` (requirement → files) is **lexical** keyword matching and is
labelled `method: "lexical"` wherever shown.

The index is built once per commit and cached (`CodeIndex`, latest 20 per
repo); a verified run indexes its new head so the next run starts current.

## Change impact and regression checks

After the engineer's attempt, the engine indexes the working tree and calls
`analyzeChange(before, after, …)`:

- dependents of the changed files and the **tests that load them**
- flags with `confidence`:
  - **confirmed** (static facts; block the attempt): a deleted file still
    imported, an import that resolves to nothing, removed dependencies still
    imported, a test that was **failing in the previous attempt** weakened or
    deleted (hiding the defect instead of fixing it)
  - **warning** (shown to reviewers and in the gate; never block on their own):
    removed API routes, frontend calls with no matching route, schema /
    migration changes, dependency additions/removals/major bumps, lockfile
    without manifest change, changed files no test loads, auth-sensitive files,
    files outside the task's declared scope, weakened pre-existing tests

Verification then runs the **focused** impacted tests first (`node --test
<files>` when the project's runner supports it; recorded as
`purpose: focused_test`) and the **full plan** (install → test → lint →
typecheck → build → check) as the gate. A focused pass never substitutes for
the full suite.

## Evidence-driven debugging

Each failed gating check becomes a `Defect` (`recordAttempt`):

1. exact command, exit code and the `CommandRun` holding the output
2. failing test names (TAP and the node:test spec reporter), implicated files
   (stack frames + the failing tests' imports)
3. a deterministic **category**: code · test_assumption · dependency ·
   configuration · infrastructure · permissions · timeout · unknown
4. a stable **signature** (failing test names, or the normalised error
   excerpt) so the same failure is recognised across attempts

The repair prompt is assembled from that evidence plus **previously verified
solutions** for the same signature from project memory — not "try again".
Infrastructure/permissions failures are not code defects: the run is
re-queued (retryable) instead of asking the engineer to "fix" the sandbox.

Stopping rules (`repeatDecision`): the same signature again after a repair →
the engineer is **escalated** to the REASONING tier; at 3 occurrences, or
when a repair leaves the tree byte-identical to the previous failed attempt,
the run stops with `stopReason: repeated_failure` (before exhausting
`maxRepairs`), defects are `ABANDONED`, the work-in-progress is committed as
"NOT verified", and the scheduler routes it to a person.

A defect is `FIXED` only when the same command later **passes**; the passing
`CommandRun` is stored as `fixedByCommandRunId`.

## Project memory

`ProjectMemory` rows are scoped by `companyId + productId`, keyed for
idempotent upserts, and carry `provenance`, `files`, `requirements`,
`sourceSha`, timestamps and a status:

| Status | Source | Retrieved? |
|---|---|---|
| VERIFIED | a VERIFIED run (passing commands, routes with passing tests, fixed defects, dependency changes that installed + passed) or a person's confirmation (ADMIN+) | yes, labelled as fact |
| ASSUMPTION | brief assumptions; routes no test loads | yes, labelled "NOT verified — confirm in the code" |
| STALE | a file it is about changed in a later verified run / rollback, or a requirement it relates to changed | **no** |
| INVALIDATED | a person (MEMBER+) | **no** |

Memory is written only from recorded outcomes — never from model text. An
assertion never downgrades a VERIFIED entry. Retrieval (`retrieve`) ranks by
the task's files, requirement ids and current defect signatures within a
character budget (default 3.5 k), so prompts carry a small relevant slice,
not the history. Content is passed through `redact()` before storage.

## Requirement traceability and invalidation

Backlog tasks carry `requirements: ["FR-1", "AC-2"]` (validated against the
brief). `reviseBrief` diffs requirement ids/texts (`changedRequirements`):

- tasks implementing a **changed or removed** requirement: VERIFIED / accepted
  / failed / blocked → `READY` (verification reset); in-flight runs →
  cancelled and the task `BLOCKED` with the reason
- tasks for other requirements are untouched
- **added** requirements are reported as `unplanned` (the gate shows them as
  "not traced to any task")
- memory about the touched requirements → STALE; scope must be re-approved
- a versioned `CHANGE_SET` artifact records what changed and why

Products planned before traceability existed (no links) fall back to
flagging every task for review.

## Budgets and cost-aware routing

- **Per run**: `Build.budgetUsd` (= product `limits.budgetUsd`).
- **Per product**: `limits.projectBudgetUsd` (default $25). The scheduler stops
  dispatching at the limit and raises a `budget` notification at 80 %.
- **Per workspace**: the plan's monthly AI budget (`billing/entitlements.ts`).

Before each agent turn the engine computes the remaining amount as the
minimum of the three and passes it to the tool loop's `shouldStop`; at zero
the run stops with `kind: budget`, work kept on the branch. Costs are
**estimates** from provider-reported tokens at list prices and labelled so.

Routing (`tierFor`): engineers use REASONING for HIGH-risk tasks and after an
escalation; the code reviewer of a LOW-risk change uses FAST; QA and security
keep their configured tier. Verification steps are never skipped to save cost.

## Cancellation and recovery

`cancelBuild` cancels the job, marks the run, and `docker kill`s the
container recorded in `Build.container` (named `aura-b-…`, only names AURA
created are accepted). The tool loop checks cancellation between turns; the
engine checks between phases. Nothing is committed after a cancel.

`recoverOrphanedBuilds` (run at the start of every scheduler tick) moves runs
still marked QUEUED/RUNNING whose job is missing or finished to `BLOCKED` with
the reason; Retry re-queues them. Live jobs with expired leases are reclaimed
by the queue itself. A finished run delivered again by the queue returns
without side effects.

## Rollback

`revertAuraCommits` reverts commits in `base..branch` authored by
`aura@localhost` as **new** commits (no history rewrite, no force push).
Commits by anyone else on that branch are kept; if a revert would conflict
with someone else's later change, nothing is changed and the API returns 409.
The default branch is never touched; a task in a pending/approved release
candidate cannot be rolled back until that candidate is rejected.

## Delivery quality gate

`evaluateGate` returns each criterion as **passed / failed / blocked /
not_verified** with evidence: requirements traced and verified · executable
tasks verified · build/type-check/lint · tests (final attempt of each verified
run) · integrated release candidate · critical journeys · API/data
consistency · security review · open review findings · regression warnings ·
approvals · blockers (blocked tasks, open defects) · delivery configuration.

Profiles (`Product.qualityProfile`, ADMIN+ to change) choose which are
**required**: `static-site`, `web-app` (default), `financial` (adds journeys,
API/data, regression, approvals). `implemented`, `approvedForRelease` and
`deployed` are separate conclusions. **Journeys are always `not_verified`
today**: AURA does not run browser tests of generated applications, so the
`financial` profile cannot be satisfied yet — by design, not by accident.

`deliveryReport` stores a `DELIVERY_REPORT` artifact built from the same
records (gate, tasks, git operations, release candidate, defects, usage); an
incomplete report is `PROPOSED`, never `APPROVED`.

## Tests

| Test | What is real | Double |
|---|---|---|
| `builder/intel.test.ts` | index/impact on the real node-web starter + ScamScout change | — |
| `builder/debug.test.ts` | real `node --test` output (buggy/fixed code run on the host), defects, memory in the DB | — |
| `factory/v3.test.ts` | planning job, scheduler, git, route handlers + authz | model HTTP endpoint |
| `builder/engine.double.test.ts` | whole engineering run: git, tool loop, `npm test`, defects, impact, memory, gate | model HTTP endpoint **and the `docker` CLI** (`test/doubles/docker-cli.mjs`, host execution with **no isolation**); skipped when real Docker works |
| `builder/builder.test.ts` | same journeys inside the real Docker sandbox | model HTTP endpoint; skipped without Docker |
| `e2e/v3.spec.ts` | browser: gate/memory/code map equal API state; live update after a requirement change | model HTTP endpoint |

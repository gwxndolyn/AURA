# Adaptive execution (V16)

Before V16 every engineering run used one strategy: implement → verify →
review → category-specific repair. V16 makes the run decide *how* to work on
each task from evidence, records each decision with its reasons, changes
strategy during the run (bounded) when the evidence says the current approach
is not working, and measures each strategy against a baseline.

| Piece | Where |
|---|---|
| Pure policy: classification, strategy, verification depth, tools, model routing, feedback controller, collaboration value, versioned policies | `src/lib/builder/adaptive.ts` |
| Evidence gathering + persisted plan, adjustments, verification status, policy get/set, metrics | `src/lib/builder/planner.ts` |
| Integration into the run | `src/lib/builder/engine.ts` (`planExecution` after the code index; `applyDecision` in the attempt loop; `routedModel` in `agentTurn`) |
| Configured model candidates; explicit model on `converse()` | `src/lib/ai/claude.ts` (`configuredModels`) |
| API | `GET/PATCH /api/companies/:id/products/:productId/execution` |
| UI | product page → **Execution** tab (`src/components/products/execution.tsx`) |
| Data | `Build.executionPlan` (JSON), `Build.adaptivePolicy`, `Product.executionPolicy` (JSON) — additive columns with defaults |

## 1. Classification (with evidence)

`classifyTask()` reads only real inputs gathered by `planExecution()`:
- the backlog item (kind, files, criteria, dependencies)
- the orchestrator's assessed risk
- the code index of the starting commit (which planned files exist, and which files import them)
- open defects for this task
- earlier runs of the task
- recent `RunOutcome`s for the same task kind
- external APIs named in the task that the code does not already import

Each dimension carries a value plus the evidence for it. The dimensions are category, scope, complexity, uncertainty, dependents, familiarity, research, risk, verification depth, collaboration and determinism. It also returns `confidence` (the share of dimensions decided) and `fastPath` (low complexity, low uncertainty, no research, not high risk), so small tasks are not over-analysed.

**Ambiguity.** Ambiguity blocks a run only when it would change the implementation: there are no acceptance criteria, or a high-risk task has vague, unmeasurable wording. A blocked run ends `BLOCKED` (`needs_clarification`) before any model call, and the questions are recorded. Other ambiguity raises uncertainty but does not block.

## 2. Strategy

`chooseStrategy()` picks the **least complex sufficient** strategy, in this order:

| Strategy | Chosen when |
|---|---|
| `high_assurance` | effective risk HIGH (auth, payments, migrations, secrets, …) |
| `test_driven_repair` | debugging: a REPAIR task, open defects, or task text describing a defect |
| `investigate_then_execute` | uncertainty not low, or an external API is not yet used in the repo |
| `collaborative` | ≥2 independent parts with disjoint files and enough work (`collaborationValue`) |
| `sequential_handoff` | UI work depending on upstream contracts |
| `plan_then_execute` | medium/high complexity |
| `direct` | everything else |

A project can pin a strategy (`pinnedStrategy`).

The plan records:
- steps, each with an agent, dependencies, a parallel flag and gates
- checkpoints, the recovery policy and the completion criteria

The engineer's first objective is shaped by the strategy (`strategyObjective`), for example "write a failing test first" or "investigate before editing". Reviewers run as the existing orchestrator decides.

**Collaboration limitation.** `collaborative` is recorded as a planning decision, but execution is still one owner agent per run. The engine does not split a run into parallel sub-runs. Parallelism across tasks stays with the product scheduler (`maxParallel`, file-overlap gating), which keeps its authority over limits and concurrency.

## 3. Verification depth

`verificationRequirements()` builds the required checks:
- every change: unit tests, full regression and code review
- by depth and risk: integration tests, security review, authorization tests, migration validation, browser journeys and explicit approval
- plus any `mandatoryChecks` set by the project

Depth is never lowered below these. After each attempt, `executedChecks()` maps what actually ran (sandbox command results, browser status, reviewer verdicts, tests that call the HTTP API or assert 401/403) onto those checks. `verificationStatus()` then marks each required check passed, failed, not_run or unavailable, and the result is persisted on the plan. A missing check means **unverified**, never passed. Checks mandated by the project's policy produce blocking findings until they pass.

## 4. Tools and models

`toolPlan()` lists the tools the task needs and whether each is permitted (from `permissions.ts`) and available. A tool that is missing or not permitted is reported as such. The tool allowlist itself is unchanged: `callTool()` stays the authority.

`routeModel()` chooses from `configuredModels()`, which lists only the Anthropic models configured on this server. The router:
- honours `allowedProviders` and `pinnedModels`
- falls back only to a model of the same or a stronger tier
- returns a blocker when no approved model fits: `preferred model unavailable` or `no compatible provider`

**Data never goes to a provider outside `allowedProviders`.** A blocked route stops the run (`model_unavailable`). Operations can mark models as down with `AURA_MODEL_UNAVAILABLE`.

## 5. Feedback controller

After a failed attempt, `adjust()` reads these signals:
- recurring defect
- unchanged tree after a repair
- files reverted to their base content
- scope growth relative to the planned files
- unproven criteria
- reviewer disagreement
- infrastructure category
- remaining budget

It picks one action: `investigate`, `add_reproduction`, `escalate_model`, `narrow_scope`, `add_reviewer`, `retry_environment` or `stop`, each with the evidence it was based on (`blocker`) and a rationale. It is bounded:
- at most `MAX_ADJUSTMENTS = 3` strategy changes per run
- the same action twice in a row is treated as oscillation and stops the run
- only one model escalation
- an unchanged tree after an investigation step stops the run
- no budget left stops the run

Each change is appended to `executionPlan.adjustments` and emitted as an event. Under `baseline` the controller is off, so the run behaves as before V16 (repeated-failure stop, category recovery). The existing repeated-failure detection still applies under both policies.

## 6. Policies, rollback and metrics

`ADAPTIVE_POLICIES` is a versioned, immutable registry: `baseline` and `adaptive-v1` (the default). The policy that applies to a run is resolved in this order:
1. `Product.executionPolicy.adaptivePolicy`
2. `AURA_ADAPTIVE_POLICY`
3. the default

**Rollback:** an admin sets `baseline`, or clears the field to return to the default. The change applies to runs that start afterwards; a resumed run keeps its stored plan. `strategyMetrics()` reports, per policy and per strategy, measured from finished runs: runs, verified, verified on the first attempt, blocked, attempts, model calls, cost and adjustments.

## 7. API and UI

- **GET** `…/execution` (VIEWER): the policy, the policy that applies, the available policies, strategies, checks and configured models, the last 30 runs with their plans, and the metrics.
- **PATCH** `…/execution` (`workspace.settings`, ADMIN): the body is validated strictly (`ExecutionPolicySchema`). Every change is audited as `PRODUCT_EXECUTION_POLICY` (category `execution`). A product in another workspace returns 404.

The Execution tab shows, for each run:
- the classification, the strategy and why
- the plan steps
- required vs executed checks
- tools, the model route and the collaboration decision
- strategy changes

It also shows the metrics table and, for admins, the policy form.

## Benchmark

`src/lib/builder/adaptive.benchmark.test.ts` runs 8 tasks through the real engine under each policy, in separate products of one workspace. The real engine here means: planning job → scope approval → scheduler → build jobs → engineer tool calls actually executed → `npm test` → review → commit, repair or stop.

The model is a test double (`test/doubles/adaptive-bench.ts`) with a documented behaviour model: it follows instructions, investigating helps on "trap" tasks, and one task is unsolvable. Without a Docker daemon the `docker` CLI double runs commands on the host with no isolation, using fixture code only.

Result of the run on 2026-10-26 (docker CLI double, model double):

| Metric | baseline | adaptive-v1 |
|---|---|---|
| Verified (of 8) | 7 | 6 |
| Verified, excluding the ambiguous task | 6 | 6 |
| Verified on first attempt | 4 | 6 |
| Attempts | 12 | 9 |
| Model calls | 55 | 44 |
| Est. cost (double's token counts) | $0.87 | $0.63 |
| Ambiguous task | built and "verified" against "feels nicer" | BLOCKED before any model call, questions recorded |
| Unsolvable task | FAILED (repeated_failure, 2 attempts) | FAILED (strategy_exhausted: investigate → stop, 3 attempts) |

Interpretation:
- Adaptive-v1 verified the well-specified tasks on the first attempt more often (6 vs 4), used fewer attempts and model calls, and refused the unmeasurable task instead of claiming it done.
- On the unsolvable task it spent one more attempt than baseline, because it investigates once before stopping.
- **Corrected criterion.** The first version of the criterion, "adaptive verifies ≥ baseline", counted the baseline's verification of an unmeasurable criterion as a success. The criterion now compares only the 7 well-specified tasks.
- These numbers measure AURA's policy around a scripted model, **not live model quality**.

## Not implemented / limits

- **V15 portfolio coordinator.** It does not exist in this repository: there is no `src/lib/portfolio` and no V15 commit. Cross-product coordination is still done by the per-product scheduler and the durable job queue (priorities, concurrency limits, workspace quotas). V16 adds no untracked work outside them.
- **Parallel sub-agent execution** within one run is not implemented (see §2).
- **Providers.** Only one provider is configured (Anthropic). The fallback logic is exercised with `AURA_MODEL_UNAVAILABLE` and policy, not with a second provider.
- **Classification** is rule-based: heuristics over text, files and history. It is not learned.
- **Policy promotion** from metrics is manual (an admin action). There is no automatic promotion.
- **Live models** are unverified: there is no API key in CI.

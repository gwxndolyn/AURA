# Operational intelligence (Operations center)

> Source of truth: `src/lib/ops/*` (rules, snapshot, reconcile, actions,
> monitor, briefing, notify, read, fixtures), routes under
> `src/app/api/companies/[id]/ops/*`, UI `src/app/app/[id]/operations`,
> `src/components/ops/*`. Tests: `src/lib/ops/ops.test.ts`,
> `ops.api.test.ts`, `e2e/operations.spec.ts`.

AURA evaluates its own persisted state with deterministic, versioned rules,
turns confirmed problems into findings with evidence, recommends actions that
call real services, and enforces an autonomy policy in code. No model decides
health; an AI summary is optional and validated.

## What was reused (no second engine/store/scheduler)

| Need | Reused |
|---|---|
| Event store | `SimulationEvent` via `emitEvent` — extended with `severity, source, resourceType, resourceId, dedupeKey, resolution`. `emitOpsEvent` writes an ops event once per dedupe key per resolution state. |
| Evidence | `MissionTaskRun`, `MissionTask`, `MissionFinding`, `MissionApproval`, `ToolCall`, `Deployment`, `Evaluation` rows. Findings reference them by id; payloads never copy logs. |
| Actions | Mission engine (`retryTask`, `pauseMission`, `resumeMission`, `cancelMission`, `advanceMission`), deploy pipeline (`rollbackDeployment` re-runs `runDeployment`), evaluation harness (`runEvaluation`). |
| Scheduling | No server timers exist by design. The monitor is request-driven (see below) with a lease like mission tasks. |
| Auth / tenancy | `requireWorkspaceAccess` on every route; all queries `companyId`-scoped; nested ids re-checked (`findFirst({id, companyId})`). |

New tables: `OpsFinding`, `OpsAction`, `OpsMonitor`, `OpsEvaluation`,
`Notification`; plus `Mission.operatorHold`, `Mission.toolTimeouts`,
`Deployment.rolledBackFrom`.

## Rules (`rules.ts`)

Each rule is a pure function over an `OpsSnapshot` and returns per resource
`fire` (with evidence + measured facts), `clear` (resolution criterion met),
or `unknown` (required evidence missing — nothing is raised; the reason is
recorded on the evaluation run and shown as "unknown, not healthy"). Every
rule documents evidence, trigger, severity, dedupe, resolution, false
positives and whether a person is needed (served by `GET …/ops/monitor`).

| Rule | Category | Fires when |
|---|---|---|
| `mission.blocked` | mission | waiting on plan/approval > `blockedMinutes` |
| `task.overrun` | mission | running > factor × agent max duration, or lease expired |
| `mission.repeated_verification_failure` | mission | ≥ N failed TEST/REVIEW runs, latest not passed |
| `mission.budget` | mission | cost ≥ ratio × budget (prediction) or stopped by budget (confirmed) |
| `mission.repairs_exhausted` | mission | UNRESOLVED blocking review findings |
| `mission.failed` | mission | FAILED with a failed required task (budget stops excluded). Resolves on COMPLETED/CANCELLED or when every failed task has a later successful run — a retried mission that is merely RUNNING stays open. |
| `agent.invalid_output` / `agent.timeouts` | agent | rate over ≥ min sample; below sample → unknown; < 2× sample → certainty "suspicion" |
| `tool.failures` | agent | tool failure rate (denials excluded — they're correct behaviour) |
| `engineering.tests_failing` | engineering | latest Docker test run failed; sandbox failures → unknown, not a test failure |
| `engineering.blocking_review_defect` | engineering | evidence-backed blocking review finding open |
| `engineering.deployment_failed` | engineering | latest deploy per env failed (simulated pipeline, labelled) |
| `engineering.integration_unavailable` | engineering | live Docker probe fails |
| `evaluation.regression` | evaluation | pass-rate drop ≥ threshold between comparable runs; config change → confirmed, same config → suspicion; < 2 comparable runs → unknown |
| `evaluation.cost_per_success` | evaluation | estimated cost/success up ≥ threshold, enough successes per window |

Certainty vocabulary: **confirmed** (recorded failure), **warning**
(threshold crossed), **prediction** (trend), **suspicion** (weak/small
sample; never critical). Read-only sample missions are ignored.

## Findings lifecycle (`reconcile.ts`)

One row per `(workspace, ruleId:resourceType:resourceId)` (unique index):
new → OPEN (+ event, + notification if it needs a person or meets the
severity threshold); still firing → evidence/`lastObservedAt`/`occurrences`
refreshed, no new event or notification (a severity *increase* escalates the
same notification); cleared → RESOLVED by `rule` with the reason; recurring
after resolution → re-opened (history keeps opened/resolved/reopened);
DISMISSED stays dismissed. Users may acknowledge, mark investigating, resolve
or dismiss; a person's "resolved" is re-opened by the next evaluation if the
condition still holds.

## Actions and autonomy policy (`actions.ts`)

Recommendations are computed server-side from the finding and current state;
each states reason, expected outcome, risks, cost, approval need and
reversibility, or why it is **unavailable** (e.g. "tool_timeout under this
mission's 50 ms override" → offers *retry with default timeouts*;
non-transient failures → retry is shown as unavailable, not as a button).
The action route only runs the server-side recommendation's target.

`decidePolicy` (pure, unit-tested) is evaluated in the action layer before
any service call; every attempt is an `OpsAction` row with `policyLevel`,
`policyRule`, `decision`, and the service's real result or error.

| Level | User-initiated | Automatic |
|---|---|---|
| OBSERVE | blocked (`level_observe`) | blocked |
| RECOMMEND | allowed with the action's min role | blocked |
| BOUNDED / CONTINUOUS | allowed with role | only allow-listed, `autoEligible`, low-risk actions; ≤ N/hour; ≤ 3 per run; never repeated for the same finding+target |

Always, regardless of level: production rollback → `requires_approval`
(must go through the existing deployment approval gate); cancel/resume/
rollback are never automatic; the monitor PUT strips non-eligible actions from
the allow-list; only ADMIN+ can change the policy. AI summaries cannot
trigger actions.

## Monitor (`monitor.ts`)

- **Event-driven**: the mission engine calls `requestEvaluation` after a
  non-successful step (throttled by the interval; never blocks the mission).
- **Scheduled reconciliation**: the app shell's notification bell sends a
  heartbeat every 60 s; the server evaluates only if `intervalSec` (≥ 30 s)
  has elapsed.
- **Manual**: "Evaluate now".
- A lease on `OpsMonitor` prevents overlapping runs; an expired lease is taken
  over after a crash. Runs are idempotent and recorded in `OpsEvaluation`
  (opened/updated/resolved/reopened/unknown/auto-actions/duration/error).
  Windows are bounded (last 400 runs/tool calls, 200 evaluations). No model
  calls. Monitoring can be disabled per workspace.

## Briefing (`briefing.ts`)

Deterministic: summary, prioritized attention list (severity × certainty ×
human-blocking × freshness × acknowledged), waiting approvals,
blocked/failing missions, evaluation regressions, unknown checks, and the
next step with its reason. Before any evaluation it says it knows nothing;
with no findings it says "no qualifying issues were detected from the
available evidence" plus the unknown count — never "healthy".

Optional AI summary (`POST …/ops/summary`, only if enabled, one FAST call):
the model receives only structured finding ids/titles/facts; output must
validate (facts with refs, interpretation, uncertainty), may cite only known
finding ids, and is rejected if it claims an action was executed. Without an
API key, or on invalid output, the deterministic summary is returned.

## Detection quality (synthetic fixtures)

`src/lib/ops/fixtures.ts` — 19 scenarios (blocked, transient timeout that
recovers, repeated verification failure, budget crossing, resolved/under
threshold, duplicates, missing evidence, sandbox down, regression with
sufficient/insufficient data, small samples, retried-not-yet-recovered,
budget-not-double-counted, seeded samples, failed deploy). Last run:
precision 1.000, recall 1.000, duplicate rate 0.000, unknowns 5/5 correct.
These numbers describe these fixtures only; they are not a production
detection rate.

## Known limitations

- No server-side scheduler: evaluations happen on mission activity, the app
  heartbeat (only while someone has the app open) or manually.
- Notifications are in-app only (AURA has no email/SMS integration).
- Thresholds are per-workspace JSON with defaults; there is no UI to edit
  them yet (API field `thresholds`).
- The AI-summary path has not been exercised against a live model.
- CONTINUOUS currently behaves exactly like BOUNDED (same allow-list, rate
  limit and per-run cap); there is no separate recurring-workflow catalog yet.

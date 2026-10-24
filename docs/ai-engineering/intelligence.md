# AI Engineering Intelligence layer

AURA can measure, diagnose and improve its own agents **from evidence**. Code:
`src/lib/intelligence/`. UI: `/app/[id]/intelligence`. API:
`/api/companies/[id]/intelligence/*`.

> **Fixture vs live.** With no `ANTHROPIC_API_KEY`, evaluations run against the
> deterministic simulator and are recorded as `mode: "simulation"` (shown as
> **fixture**). The simulator ignores prompt wording, so fixture runs test the
> harness, policies, tools and permissions. They do **not** measure prompt
> quality. Fixture evidence is never used for model routing or model-swap
> recommendations. Set a key to collect live evidence.

## Status

| Capability | Status |
|---|---|
| Evaluation framework (persisted `Evaluation` + `EvalResult`, versions, tokens, cost, latency, failure category) | Implemented, tested |
| 10 versioned datasets (PM, Architect, FE, BE, QA, DevOps, Security, CEO, Red, Blue), normal + difficult cases | Implemented, tested |
| Deterministic evaluators (schema, assertions, policy, expected-failure) | Implemented, tested |
| Prompt registry with immutable, content-hashed versions; `AgentRun.promptRef` recorded on every turn | Implemented, tested |
| A/B experiments (same dataset version + seed salts, repetitions, variance) | Implemented, tested. Fixture mode only on this machine |
| Release gates, gated promotion (ADMIN), rollback, blocked-promotion records | Implemented, tested |
| Agent scorecards (5 dimensions, denominators, sample-size confidence) | Implemented, tested |
| Evidence-based routing policy + safe default | Implemented. **Advisory only:** `runAgent` still routes by tier |
| Failure taxonomy (20 categories), grouping, root-cause *hypotheses* | Implemented, tested |
| Knowledge proposals + human review (approve/reject/edit/deprecate/delete) | Implemented, tested. Not yet injected into agent context |
| Skill/prompt-library audit (`npm run audit:skills`) | Implemented, tested |
| Cost recommendations | Partial: cheaper-model + retry-waste only; context/handoff/replace-with-code signals not instrumented |
| Model-based (LLM-judge) evaluator | Not implemented |
| Live-provider evaluation | Supported; **not executed here** (no key) |

## How an evaluation runs

`runEvaluation()` (`evaluation.ts`) loads the dataset and the prompt version.
Both are scoped to the workspace. It checks the daily budget, then calls
`runCase()` (`harness.ts`) for each case. Each harness type uses a real control
path:

| Harness | What it does |
|---|---|
| `model` | `complete()` with the version's system prompt. Refusal and `ESCALATE` markers are detected. |
| `tool` | The real permission check (`isAllowed`), then a bounded executor that enforces a timeout and validates output. |
| `injection` | Feeds untrusted content to the model, then sends the requested tool through the permission check. |
| `budget` | Enforces a per-case budget before the model call. |
| `sandbox-repair` | Runs real `node --test` in Docker and repairs a buggy implementation. Without Docker the case is **skipped**, not counted as a pass. |

Two deterministic pre-flight checks in `policy.ts` run before each case:
refusing attacks on real targets, and escalating when required inputs are
missing. `runAgent` uses the same safety check for real agent turns.

Limits per evaluation: `AURA_EVAL_MAX_MODEL_CALLS` (40), `AURA_EVAL_MAX_COST_USD`
($1) and `AURA_EVAL_TIMEOUT_MS` (120s). At most 2 evaluations run at once per
workspace, and evaluations can be cancelled. Stored outputs are redacted
(`redact.ts`).

## Metrics (see `scorecard.ts`)

Every metric is `{ value, numerator, denominator, formula }`. When the
denominator is 0 the value is `null` and the UI shows "—". Sample-size
confidence levels are: none (0), very-low (<5), low (<20), moderate (<50), high.

- **Quality:** acceptance = passes/runs · validity = schema-valid/runs · correctness-by-tests = passing test runs/test runs · regressions/runs.
- **Reliability:** completion · retries/run · timeouts/runs · tool failures/tool calls · recovered/recovery attempts.
- **Efficiency:** mean latency · mean tokens · cost/passes · model and tool calls per run.
- **Security:** unauthorized attempts/run (counted even when denied) · runs with a policy violation · unsafe-output runs · resisted/injection cases · correct/escalation cases.
- **Collaboration:** handoff success and rework (tagged cases), plus production handoffs and bug reports from `AgentMessage`.

## Release gates (`gates.ts`)

| Gate | Default | Waivable |
|---|---|---|
| Correctness floor | pass rate ≥ 0.8 | never |
| Security cases | 100% | never |
| Structured-output validity | ≥ 0.9 | never |
| Correctness regression vs baseline | none allowed | never |
| Security regression vs baseline | none allowed | never |
| Cost increase | ≤ 20% | OWNER waiver only |
| Latency increase | ≤ 50% | OWNER waiver only |

An experiment may tighten hard gates but cannot loosen them.

## Workflows

- **Run an evaluation:** in the UI, use the Overview tab and pick a dataset. Or
  call `POST …/intelligence/evaluations {agentKey, datasetId, promptVersionId?}`
  (MEMBER).
- **Compare prompt versions:** create a DRAFT with `POST …/prompts`
  `{templateKey, content, changelog}`. Then run
  `POST …/experiments {templateKey, baselineVersionId, candidateVersionId, repetitions?}`.
  The candidate becomes APPROVED, stays EVALUATING, or goes back to DRAFT,
  depending on the gate results.
- **Promote:** `POST …/promote {candidateVersionId}` (ADMIN). This runs a fresh
  regression evaluation and checks the gates against the active version's latest
  evaluation. If any gate fails, the promotion is recorded as `BLOCKED` with
  reasons and the active version does not change.
- **Roll back:** `POST …/rollback {templateKey, targetVersionId, reason}` (ADMIN).
  The target must be a version that was previously active.
- **Routing policy:** `PUT …/models` (ADMIN). The security-sensitive floor stays
  fixed at 1.0.
- **Knowledge:** `POST …/knowledge {source, sourceId}` proposes entries.
  `PATCH …/knowledge/[entryId]` reviews them (ADMIN approves).
- **Skill audit:** run `npm run audit:skills`, or call `GET …/skills-audit`
  (ADMIN).

## Tests

`src/lib/intelligence/{core,governance,workflow,api}.test.ts`. They run against
the real Prisma DB and route handlers. The only stub is `next/headers` cookies,
which receives a real signed session.

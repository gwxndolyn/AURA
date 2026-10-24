# Multi-agent collaboration

> Source of truth: `src/lib/agents/capabilities.ts`, `contracts.ts`, `toolSpecs.ts`,
> `tools.ts`; `src/lib/missions/planner.ts`, `context.ts`, `executor.ts`,
> `engine.ts`, `repos.ts`, `timeline.ts`. Tests:
> `src/lib/missions/collaboration.test.ts`, `collaboration.api.test.ts`,
> `e2e/collaboration.spec.ts`. Extends the mission engine in
> [missions-and-demo.md](missions-and-demo.md) — there is one engine.

## What makes the agents different (enforced in code)

`capabilities.ts` declares, per agent, what the planner, scheduler and tool
runner enforce. It cannot widen permissions: `validateRegistry()` (tested)
requires capability tools ⊆ the role allowlist in `permissions.ts`.

| Agent | Owns task kinds | Writes code | Verification applied to its work |
|---|---|---|---|
| product-manager | REQUIREMENTS, ANALYSIS, REPORT | no | output contract |
| architect | ARCHITECTURE, ANALYSIS | no | contract; named files checked against the repository |
| backend / frontend-engineer | CODE_CHANGE (backend / frontend domain) | yes, only inside the task's write scope | contract + sandbox tests |
| qa-engineer | REPRODUCE, TEST | no | real `node --test` in Docker; results decide |
| reviewer | REVIEW | no | every concern must be reproduced by an executed probe |
| security-engineer | SECURITY_REVIEW | no | deterministic checks on the final code |
| devops | APPROVAL | no | human decision; deploy tools need an APPROVED approval id |

Each also has a model tier, max duration, per-task cost budget, context budget
and retry policy (which failure categories may be retried, how many times).

## Flow of one task attempt (`executor.ts`)

1. **Context** (`context.ts`): sources are gathered deterministically —
   objective, acceptance, the task (with its enforced write scope), validated
   handoffs from *direct dependencies only*, the code in scope (+ files the
   architect named), tests, the latest recorded test evidence, open blocking
   findings, conventions, security constraints, previous attempts. Required
   kinds come from the capability. They are fitted to the agent's token budget:
   optional sources are omitted first; required truncatable sources are cut
   with a recorded note; if required content still does not fit →
   `context_overflow` (no model call). Provenance (`id, kind, ref, tokens,
   required, included, truncated`) is stored on the run.
2. **Budget**: before *every* model call the mission budget and the per-task
   budget are re-read; exhausted → `budget_exceeded`, no call is made.
3. **Work** through `callTool()`, which now validates arguments and results
   against `toolSpecs.ts`, enforces timeouts, refuses writes outside the task's
   write scope, and refuses consequential tools (`deploy.*`) without an
   APPROVED approval. Every call is a `ToolCall` row with status + duration.
4. **Output**: the structured output is built from tool evidence (test counts,
   artifact ids, code hashes) and validated against the kind's Zod contract
   (`contracts.ts`). Model prose is stored separately as an unverified `claim`.
5. **Handoff**: a `MissionHandoff` (validated by `HandoffSchema`) is persisted
   for dependents. A dependent whose dependency handoff is missing or invalid
   fails with `agent_handoff_failure` — it never runs on a guess.
6. **Run record**: `MissionTaskRun` stores attempt, agent, model/tier/mode,
   tokens (incl. cache read/write when the provider reports them), whether
   usage was **estimated**, cost, latency, retries, context provenance,
   output, validation errors, tool log and error category.

## Delegation (`planner.ts`)

Templates declare task *requirements* (kind, domain, tools, writes). The
deterministic `assignAgent()` picks an agent that owns the kind, covers the
domain, holds every tool and may write when writing is required — cheapest
tier first, then narrowest specialist. No fit → `AssignmentError` listing why
each candidate was rejected; the plan fails rather than using an unrelated
agent. The reason is stored on the task (`assignmentReason`).

The workflow depends on risk: LOW = requirements → architecture ∥ reproduce →
fix → verify → review → report; MEDIUM adds a security review; HIGH also adds
the human release gate. `validatePlan` rejects cycles, a code change without
an independent TEST and REVIEW, self-review, a kind the agent cannot own, and
two concurrently-runnable tasks that write the same file. At runtime a
`MissionLock` per file (all-or-nothing, lease-expiring) prevents concurrent
writers anyway.

## Review, findings and bounded repair

- QA failures become a finding (source `qa`) with the test report as evidence.
- The reviewer's model output names concerns; the **engine runs each one as a
  probe** (a real `node:test` file against the changed module in Docker) plus
  the repo's required probes. A failing probe → supported finding with the
  probe artifact and code hash as evidence. A passing probe, or a concern that
  names no executable probe → recorded as UNSUPPORTED, never blocking.
- A blocking finding opens a repair round: the implementing task and every
  task downstream of it go back to PENDING. The repair run records which
  findings it addresses; they are RESOLVED only when the re-run probe/test
  passes on the new code.
- `mission.maxRepairs` bounds the loop. At the limit, findings become
  UNRESOLVED and the mission fails "needs intervention". A repair that
  produces byte-identical code fails immediately (`code_generation_failure`).
- A mission completes only when every required task succeeded **and** no
  blocking finding is open.

## Recovery and cancellation

- Expired lease → the task is re-queued, its in-flight run is marked
  `ABANDONED` (`worker_lost`), and its file locks are released.
- Cancelling stops new scheduling; a step in flight is stopped before its next
  model call (`CancelledError`) and its result is discarded (run `CANCELLED`,
  task `SKIPPED`).

## Timeline and scorecards

`GET …/missions/:id/timeline` is assembled from plans, runs, findings,
handoffs and approvals — nothing synthesized. Each entry lists `facts`
(system-recorded) separately from `claim` (agent narrative). `…/runs/:runId`
and `…/handoffs/:handoffId` expose the inspectable detail (IDOR-scoped to
mission + workspace).

`GET …/missions/scorecards` computes per-agent metrics from mission runs in
the workspace (sample missions excluded). Every metric carries numerator,
denominator and a definition; running, cancelled and abandoned attempts are
excluded from denominators; sample confidence is shown and the UI warns when
it is too low to compare agents. Mission scorecards are **not** used for model
routing — routing remains the evaluation-gated policy in
`intelligence/routing.ts`.

## Fixture repositories (`repos.ts`)

| Template | Defect | Reviewer probes |
|---|---|---|
| `checkout-fix` | float rounding undercharges by a cent | fractional / zero quantity |
| `checkout-validation` | `quantity < 0` lets 0 through (failing test) | fractional, NaN, string quantity, negative price |

Without an API key the engineer applies prepared repair candidates (labelled
`simulated-candidate`); test runs and probes still execute for real. With an
API key the engineer returns full file contents, applied only inside the
write scope.

## Fault injection (tests only)

`missions/faults.ts` lets tests make a model return malformed/refusing output,
a tool hang/error/return garbage, Docker be "down", inject a code candidate,
or run a hook mid-step. It throws outside `NODE_ENV=test`.

# Product lifecycle

Code: `src/lib/factory/*` · UI: `/app/[id]/products` · API:
`/api/companies/[id]/products/*` · Tests: `src/lib/factory/factory.test.ts`,
`factory.api.test.ts`, `e2e/factory.spec.ts`.

## Phases

`DISCOVERY → PLANNING → DESIGN / ARCHITECTURE / BUILD / VERIFY / ITERATE →
RELEASE_READINESS → DEPLOY → OPERATE`

Work phases overlap and connect in both directions; any phase can return to
an earlier one when evidence demands it (a failing check → `ITERATE`, a design
mismatch → `DESIGN`). `RELEASE_READINESS` is entered only by building a
release candidate; `DEPLOY`/`OPERATE` only by deployment actions. Edges are
in `lifecycle.ts` (`canMovePhase`). Every change is a `LifecycleTransition`
row: `fromPhase`, `toPhase`, `reason`, `actor`, `evidence[]`, timestamp.

The phase is **derived** from persisted backlog state on every scheduler tick
(`derivePhase`): open repair or failed executable task → ITERATE; a mission in
its TEST/REVIEW stage → VERIFY; running code tasks → BUILD; open design /
architecture work → DESIGN / ARCHITECTURE.

## Backlog

`Product → EPIC → STORY → TASK → REPAIR`, each with a stable key (`E1.S1.T3`,
`E1.S1.T3.R1`), acceptance criteria, dependencies (keys, acyclic), effort
**estimate** in points (never presented as measured time), required agent
capability, known files, verification requirements, risk, status,
verification status, attempts, evidence and history.

**Executable** means a real codebase + test suite covers every file the task
names. Only executable tasks can be VERIFIED.

### Item status

`TODO → READY → IN_PROGRESS → IN_REVIEW → VERIFIED`, plus `FAILED`,
`BLOCKED`, `DONE_UNVERIFIED`, `CANCELLED`.

- `VERIFIED` — set **only** by the engine, only when the task's mission
  completed, its final tests ran in the Docker sandbox and passed, and every
  acceptance criterion in the mission report is `met`.
- `DONE_UNVERIFIED` — set **only** by a person, **only** for non-executable
  work (e.g. an approved design spec). Shown as "accepted · unverified".
- Verification status is separate: `NOT_RUN | RUNNING | PASSED | FAILED |
  BLOCKED | INCONCLUSIVE`. If tests could not run (no Docker), the task is
  BLOCKED + INCONCLUSIVE, never verified.

Stories and epics roll up from their tasks (`rollUp`).

## Scheduler (one bounded tick)

`tickProduct()` — triggered by **Run team** or `POST …/tick`:

1. Refuses to run unless the product is ACTIVE and the scope is approved.
2. Advances in-flight missions (bounded steps), syncs their file changes, and
   settles finished ones **from evidence** (`buildReport`).
3. Failure → `FAILED` + a REPAIR item referencing the failing tests/finding,
   routed to the same capability; beyond `maxAttempts` the task is `BLOCKED`
   with a summary and an intervention notification.
4. Dispatches ready tasks (deps VERIFIED or accepted-unverified) up to
   `maxParallel`, never two running tasks that share a file. DESIGN /
   ARCHITECTURE tasks produce artifacts for review; other non-executable tasks
   are BLOCKED with the reason.
5. Rolls up parents and re-derives the phase.

A product-level lease (`tickLeaseUntil`) prevents overlapping ticks; an
expired lease (crash/restart) is taken over. Missions keep their own task
leases and `worker_lost` recovery. Ticks are idempotent.

## Limits (per product, clamped)

`maxRepairs` (in-mission repair rounds, 0–5) · `maxParallel` (1–4) ·
`budgetUsd` per task (0.01–10) · `maxAttempts` dispatches per task (1–3).
Workspace-wide budget and loop guards from `ai/budget.ts` and
`agents/guardrails.ts` still apply to every model call.

## Approvals

`ProductApproval` per consequential action, with action class, target,
summary, risks, evidence and a payload hash re-checked before side effects.

| Action | Class | Who may decide |
|---|---|---|
| scope | analysis | MEMBER+ |
| release_candidate | local_commit | MEMBER+ |
| publish (push + PR/MR) | external_publication | ADMIN+ |
| deploy_production | production | ADMIN+ |

Production, infrastructure and external publication require a person at
**every** autonomy level (`policy.ts`).

## Answering "where is my project?"

The Overview tab answers: phase and milestone · what the team is doing now ·
blocked work and why · verified work · pending approvals · usage (estimated)
· "what happens next". Progress has exactly one definition: verified
executable tasks ÷ executable tasks (non-executable counted separately).

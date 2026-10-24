# Agent orchestration patterns

How to compose agent turns. The runtime is in
[../architecture/agent-orchestration.md](../architecture/agent-orchestration.md);
this is the "which pattern, when."

## Pick the simplest that works

| Pattern | Use when | AURA example |
|---|---|---|
| **Single agent** | One bounded task, one role | `runAgent` for a plan/analysis |
| **Sequential pipeline** | Steps depend on each other | `executeTask`: implement → build → test → gate |
| **Loop with gate** | Retry until a real check passes | `selfHeal`: test → bug report → fix → rerun (bounded) |
| **Supervisor / arbiter** | Conflicting opinions need a decision | `resolveConflict`: architect decides on evidence |
| **Reassignment** | An agent is unavailable | `reassignFromUnavailable` → fallback peer |
| **Parallel agents** | Independent subtasks, then merge | fan-out analysis (compose with `Promise.all`) |
| **Human approval gate** | Consequential/irreversible action | `requestDeploy`/`resolveApproval` |

Don't reach for multi-agent when one agent + deterministic code will do. Added
agents mean coordination overhead, more failure modes, and more cost.

## Coordination concerns (and AURA's answers)

- **Failure recovery** — bound every loop (`selfHeal.maxAttempts`, guardrails);
  end in a recoverable state (`REVIEW`/`BLOCKED`), never an infinite retry.
- **Shared state** — the DB is the source of truth; agents read/write scoped rows,
  not in-memory globals. Persist progress so a crash is recoverable.
- **Conflicting decisions** — route to an arbiter (`resolveConflict`) and record a
  `Decision`; don't let two agents fight in a loop.
- **Concurrency** — avoid two turns mutating the same entity simultaneously; drive
  sequencing from the workflow, not from the model.
- **Budget/loops** — `checkBudget` (hard-stop) + `checkLoop`
  (iterations/tool-calls/runtime) apply across the whole run.

## Building a durable multi-agent workflow

Use the `aura-autonomous-workflow` skill. Requirements:

- Explicit workflow **states** persisted in the DB (not just in a function).
- **Task dependencies** and clear agent responsibility boundaries.
- **Idempotent** steps; **bounded** retries; **cancellation**; **timeouts**.
- **Human approval gates** for consequential actions, enforced server-side.
- **Audit events** at each transition; **failure recovery** paths.
- **Integration tests** (mirror the stress test's invariant checks).

Anti-pattern: an uncontrolled `while` loop of model calls with no persisted state,
no bound, and no gate. The stress test (`runStressTest`) exists to prove the real
workflows survive all failure modes at once — add your workflow to that bar.

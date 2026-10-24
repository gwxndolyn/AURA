---
name: aura-autonomous-workflow
description: Implement a durable multi-step, multi-agent workflow in AURA — explicit persisted states, task dependencies, idempotent steps, bounded retries, cancellation, timeouts, human approval gates, audit events, and invariant tests. Use for multi-agent orchestration, never an uncontrolled model loop.
---

# aura-autonomous-workflow

## When to use
Building a workflow that coordinates several agent turns/steps and must be durable.

## Required context
`docs/ai-engineering/agent-orchestration.md`, `docs/workflows/standard-ai-workflows.md`,
`docs/architecture/events-and-jobs.md`. Patterns: `executeTask`, `selfHeal`,
`deployWithRetry`, `resolveConflict`, `reassign`, `approval`, `stressTest`.

## Requirements (all)
1. **Explicit states** persisted in the DB (a status column), not just in a
   function. Each step **idempotent**.
2. **Task dependencies** + clear agent responsibility boundaries. Reuse `runAgent`,
   `callTool`, `sendMessage`, `resolveConflict`, `reassignFromUnavailable`.
3. **Bounded retries** (like `selfHeal.maxAttempts`/`deployWithRetry`),
   **cancellation**, **timeouts**. Respect `checkBudget` + `checkLoop`.
4. **Human approval gates** enforced server-side (`PENDING_*` state + resolve route
   with `requireWorkspaceAccess`), like `requestDeploy`/`resolveApproval`.
5. **Audit events** at each transition; **failure recovery** to a recoverable state.
6. **Integration tests** asserting invariants under failure (mirror `runStressTest`:
   no duplicate execution, state intact, permissions enforced, terminal states).

## Anti-pattern (reject)
An uncontrolled `while` loop of model calls with no persisted state, no bound, no
gate.

## Security
Each agent keeps its own tool allowlist; no privilege inherited via handoff.
Consequential actions gated. Scope everything by `companyId`.

## Validation
`npm run typecheck && npm test`; invariant tests pass under injected failures.

## Definition of done
A persisted state machine with idempotent steps, bounds, approval gates, audit, and
invariant tests green.

## Final report
Workflow states + transitions · agents/tools used · bounds/approvals · invariant
tests + results.

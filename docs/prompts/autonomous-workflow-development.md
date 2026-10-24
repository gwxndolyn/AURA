# Prompt: autonomous workflow development

**When to use** — build a durable multi-step workflow using several agents.

**What to provide** — the goal, the steps/agents, and the approval points.

## The prompt

```
Use the `aura-autonomous-workflow` skill. Design and implement a durable
multi-agent workflow in AURA:

GOAL: [WHAT_THE_WORKFLOW_ACHIEVES]
STEPS / AGENTS: [ORDERED_STEPS_AND_WHICH_AGENT]
APPROVAL POINTS: [WHERE_A_HUMAN_MUST_APPROVE]

Requirements (do NOT implement this as an uncontrolled loop of model calls):
1. Explicit workflow STATES persisted in the DB (a status column), not just
   in-function. Each step idempotent.
2. Task dependencies + clear agent responsibility boundaries (reuse runAgent,
   callTool, sendMessage, resolveConflict, reassignFromUnavailable as fits).
3. Bounded retries (like selfHeal maxAttempts / deployWithRetry), cancellation,
   timeouts. Respect checkBudget + checkLoop.
4. Human approval gates enforced server-side (PENDING_* state + resolve route with
   requireWorkspaceAccess), like requestDeploy/resolveApproval.
5. Audit events at each transition; failure-recovery paths to a recoverable state.
6. Integration tests that assert invariants under failure (mirror runStressTest:
   no duplicate execution, state intact, permissions enforced, terminal states).

RUN npm run typecheck && npm test. Follow
docs/ai-engineering/agent-orchestration.md.
```

## Expected deliverables
A persisted state machine with idempotent steps, bounds, approval gates, audit, and
invariant tests.

## Verification
Invariant tests pass under injected failures; no duplicate execution; recoverable
on crash.

## Common failure modes
Uncontrolled model loop; state only in memory; no bounds/cancellation; approval only
in the UI.

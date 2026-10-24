# AI evaluation & testing

Probabilistic behavior needs a different discipline than unit tests. A single good
manual run proves nothing. Tooling: the `aura-ai-evaluation` skill.

## What AURA already does

- The **simulator is deterministic & seeded** (`seededRandom`, seed =
  `companyId:agentKey:objective`), so offline behavior is reproducible and unit
  tested (`simulator.test.ts`): structured plans, security goals → security tasks,
  determinism per seed, attack/test shapes.
- **Permission behavior** is tested (`permissions.test.ts`): red-team can't deploy,
  only engineers write code, etc.
- The **stress test** (`runStressTest` / e2e) asserts invariants: permission
  enforced, self-heal reached DONE with real tests, conflict resolved, reassignment
  happened, incident verified, deploy retried to success, no duplicate execution,
  state intact across repeated runs.

Use these as the template for AI tests.

> **Implemented:** the framework described here exists. See [intelligence.md](intelligence.md) for datasets, the harness, gates, and how to run them.

## Build an eval set

For an agent/prompt, assemble **fixed cases**: representative inputs, edge cases,
and regressions (every past failure becomes a case). For each, record:

```
model version · prompt version · input · expected outcome/shape ·
actual result · token usage · latency · pass/fail
```

Assert on **shape and invariants**, not exact prose:

- Structured output validates against the schema (see
  [structured-outputs](structured-outputs.md)).
- Tool selection is within the role allowlist.
- Instruction adherence (e.g. a security task produces a security finding).
- Security behavior (an unauthorized tool is refused — the stress test does this).
- Recovery from a failure (bad input → recoverable state, not a crash).
- Context retrieval returns relevant memory.
- Handoffs produce the right `AgentMessage`.

## Thresholds & cost

Set a pass threshold over the set (e.g. N/N invariants, ≥X% of soft cases). Track
**cost and latency** per case and alert on regressions — a "better" prompt that
doubles cost may not be better. Keep a human review step for subjective quality.

## Running

- Deterministic/offline (simulation mode): fast, in CI via `npm test`. Prefer this
  for most agent-logic coverage.
- Live model: gate behind a key; keep a small, cheap live smoke set. Don't make CI
  depend on a paid API.

## Don't

- Don't evaluate on a few handpicked successes.
- Don't assert exact strings from a live model.
- Don't let an eval mutate shared/real data — use seeded, isolated companies.

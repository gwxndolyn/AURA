---
name: aura-ai-evaluation
description: Build and run evaluations for AURA's AI agents — fixed datasets, shape/invariant assertions, tool-selection and security-refusal checks, with recorded model/prompt version, cost, and latency. Use to measure whether an agent actually improved.
---

# aura-ai-evaluation

## When to use
Measuring agent/prompt quality objectively (not a single manual run).

## Required context
`docs/ai-engineering/evaluation-and-testing.md`, `structured-outputs.md`. Existing
patterns: `simulator.test.ts`, `permissions.test.ts`, `runStressTest` invariants.

## Workflow
1. Assemble a **fixed eval set**: representative inputs + edge cases + regressions
   (every past failure) + an injection-refusal case. Use seeded, isolated companies.
2. Assert on **shape and invariants**, not exact prose:
   - output validates against schema,
   - tool selection within the role allowlist,
   - instruction adherence (e.g. security goal → security finding),
   - security behavior (unauthorized tool refused),
   - recovery from failure (bad input → recoverable state),
   - context retrieval returns relevant memory,
   - handoffs produce the right `AgentMessage`.
3. Record per case: **model version, prompt version, input, expected, actual,
   tokens, latency, pass/fail.**
4. Set a pass threshold; track cost/latency and flag regressions. Keep a human
   review for subjective quality.
5. Prefer deterministic/simulation-mode eval in CI; gate any live-model eval behind
   a key (small, cheap).

## Must NOT
Evaluate on handpicked successes; assert exact strings from a live model; let an
eval mutate shared/real data.

## Validation
`npm test` runs the eval cases; thresholds met.

## Definition of done
A repeatable eval set with recorded metrics, security case, and a threshold —
showing measured improvement or regression.

## Final report
Eval set summary · pass rate · cost/latency · model/prompt versions · verdict.

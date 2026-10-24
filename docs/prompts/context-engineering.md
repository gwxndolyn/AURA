# Prompt: context engineering

**When to use** — an agent gets too much (costly/slow/diluted) or too little
(wrong) context.

**What to provide** — the agent/workflow and the symptom.

## The prompt

```
Reduce irrelevant context for [AGENT_KEY / WORKFLOW] in AURA while preserving
correctness.

SYMPTOM: [HIGH_COST / SLOW / WRONG_DUE_TO_MISSING_OR_NOISY_CONTEXT]

1. Read orchestrator.ts (how the prompt is assembled: company snapshot + retrieved
   memory + inline context + objective) and memory.ts (retrieveContext scoring,
   20-item short-memory cap).
2. Measure current prompt token size + cost/latency on a few representative turns.
3. Identify what's unnecessary (stale snapshot fields, over-broad memory, untruncated
   tool output) and what's missing for correctness.
4. Make a focused change: improve retrieval relevance, truncate large/tool outputs,
   drop unused snapshot fields — without losing information the task needs.
5. Re-measure; confirm output quality held (eval cases) and tokens dropped.

Never trade correctness for fewer tokens. Keep untrusted content in labeled
sections. Follow docs/ai-engineering/context-engineering.md.
```

## Expected deliverables
A measured context reduction with unchanged (or better) output quality.

## Verification
Lower token/cost on sample turns; eval cases still pass.

## Common failure modes
Dropping needed context; widening the memory window; forgetting to truncate tool
output; no measurement.

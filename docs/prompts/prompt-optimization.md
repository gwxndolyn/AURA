# Prompt: prompt optimization

**When to use** — improve a specific agent/system prompt methodically.

**What to provide** — which prompt, the quality bar, and example inputs.

## The prompt

```
Optimize the prompt for [AGENT_KEY / WHICH_PROMPT] in AURA.

QUALITY BAR: [WHAT_GOOD_LOOKS_LIKE]
REPRESENTATIVE INPUTS: [3-6_INPUTS_INCL_EDGE_CASES]

1. Read the current prompt (definitions.ts) and how it's assembled in
   orchestrator.ts (system vs context sections).
2. Build an eval set from the representative inputs (fixed, with expected
   shape/invariants). Include a regression for any known past failure and an
   injection-refusal case.
3. Measure the CURRENT prompt against the set: pass rate, token usage, latency.
4. Propose changes one lever at a time (clarify objective, tighten output schema,
   add uncertainty/stopping instructions, trim context). Keep stable instructions
   in system, task data in context.
5. Re-measure after each change; keep only measured wins. Record model + prompt
   version with before/after numbers.

Do not place secrets or authorization rules in the prompt. Follow
docs/ai-engineering/prompt-engineering.md.
```

## Expected deliverables
An eval set, before/after metrics, and a versioned improved prompt.

## Verification
Pass rate up, no cost/latency regression, injection case still refused.

## Common failure modes
No baseline; many changes at once; optimizing prose a model won't honor; cost blow-up.

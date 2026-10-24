# Prompt: improving an existing agent

**When to use** — an agent underperforms (wrong tool choices, weak output, drift).

**What to provide** — the agent key, the symptom, and example failures.

## The prompt

```
Diagnose and improve the "[AGENT_KEY]" agent in AURA.

SYMPTOM: [WHAT_GOES_WRONG]
EXAMPLE FAILURES: [INPUTS_AND_BAD_OUTPUTS]

1. Read its AgentDef (src/lib/agents/definitions.ts) and how it's invoked
   (runAgent calls, the `kind`, the context assembled in orchestrator.ts).
2. Reproduce the failures as eval cases first (fixed inputs, expected shape).
3. Diagnose: is it the prompt, the context (too much/too little/stale), the tool
   allowlist, the tier, or output parsing? Be specific.
4. Make a focused change (prompt wording, tier, retrieval, or validation) — one
   lever at a time.
5. Re-run the eval cases; compare output quality, token usage, and latency before
   vs after. Keep the change only if it measurably helps.
6. Record model + prompt version with the results.

Do NOT blind-rewrite the prompt. Improve it against the eval cases. Follow
docs/ai-engineering/prompt-engineering.md and evaluation-and-testing.md.
```

## Expected deliverables
Eval cases, a diagnosed cause, a measured improvement (quality + cost + latency),
versioned.

## Verification
The eval set improves without a cost/latency regression; no new failures.

## Common failure modes
Rewriting blind; changing many things at once; judging on one example; ignoring cost.

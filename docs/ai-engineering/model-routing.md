# Model routing

AURA routes by **tier**, not by hardcoded model id, so cost/capability decisions
live in one place.

## Tiers

| Tier | Default (env-overridable) | Use for |
|---|---|---|
| `FAST` | `CLAUDE_MODEL_FAST` = `claude-haiku-4-5-20251001` | classification, summarization, QA, support, analytics |
| `STANDARD` | `CLAUDE_MODEL_STANDARD` = `claude-sonnet-5-5` | coding, product planning |
| `REASONING` | `CLAUDE_MODEL_REASONING` = `claude-opus-5-5` | architecture, security, decisions, red/blue |

`MODELS` in `src/lib/ai/claude.ts` maps tier → id. Each `AgentDef` has a default
`tier`; `runAgent({ tier })` can override per call.

## How to choose a tier

- Start at the **lowest tier that reliably passes evals** for the task. Escalate
  only when quality demands it.
- Fast, high-volume, low-stakes (summaries, QA checks) → `FAST`.
- Normal engineering work → `STANDARD`.
- High-stakes reasoning (architecture, security analysis, decisions) → `REASONING`.

## Keep it honest

- Don't point all three tiers at the same big model to "improve quality" — you lose
  the cost control the router exists for.
- When you override tier per call, do it for a reason (a specific hard task), not
  by default.
- Changing a model env var changes behavior and cost — re-run evals
  ([evaluation-and-testing](evaluation-and-testing.md)) and update pricing in
  `pricing.ts` if a new family is introduced.

See also [token-and-cost-management](token-and-cost-management.md) and
[model-provider-abstraction](model-provider-abstraction.md).

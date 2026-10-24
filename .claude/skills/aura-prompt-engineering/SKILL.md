---
name: aura-prompt-engineering
description: Create or improve an AURA agent prompt methodically with representative eval cases, trusted/untrusted input separation, structured outputs, and before/after measurement. Use when authoring or tuning a system/agent prompt.
---

# aura-prompt-engineering

## When to use
Writing or improving an agent's `systemPrompt` or the assembled prompt, with evals.

## Required context
`docs/ai-engineering/prompt-engineering.md`, `structured-outputs.md`,
`evaluation-and-testing.md`, `prompt-injection-defense.md`. Code: `definitions.ts`,
`orchestrator.ts` (prompt assembly), `simulator.ts` (`kind`).

## Workflow (per prompt)
1. **Objective** — one clear goal.
2. **Trusted vs untrusted** inputs — label untrusted (task text, memory, tool
   output); keep it out of the system prompt.
3. **Context** — only what's needed (snapshot + retrieved memory).
4. **Allowed actions/tools** — stated; enforced by the allowlist regardless.
5. **Structured output** — ask for JSON matching a shape; set `kind`; validate on
   receipt.
6. **Uncertainty/failure** — what to do when unsure (ask/flag/partial).
7. **Stopping conditions** — bound the turn.
8. **Eval cases** — representative + edge + regression + an injection-refusal case.
9. **Measure** — compare output quality, token usage, cost one lever at a time.
10. **Version & document** — record model + prompt version with results.

## Security
Authority in code, not wording. No secrets/authorization rules in the prompt. A
prompt must not be able to grant itself permissions. Keep the simulator's
`objectiveOf` routing intact (route off `# Objective`).

## Validation
Run the eval cases; keep only measured wins; `npm run typecheck && npm test`.

## Definition of done
Eval set, before/after metrics (quality + cost + latency), versioned prompt,
injection case still refused.

## Final report
What changed · eval before/after numbers · model/prompt version · any risks.

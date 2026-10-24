---
name: aura-ai-agent
description: Add or modify an AI employee (or an agent tool) in AURA — registry definition, least-privilege tools, model tier, memory, handoffs, evals, and integration. Use when creating/changing an agent or adding a tool to the allowlist.
---

# aura-ai-agent

## When to use
Adding/modifying an agent in `src/lib/agents/definitions.ts`, or adding a tool to
`ALL_TOOLS`/`ROLE_PERMISSIONS`.

## Required context
`docs/workflows/adding-an-ai-agent.md`, `docs/workflows/adding-a-tool.md`,
`docs/ai-engineering/tool-calling.md`, `docs/security/agent-permissions.md`.

## Workflow (agent)
1. **Responsibility** — one clear job; confirm no existing agent (12) covers it.
2. **Identity** — add an `AgentDef` (key, name, role, avatar, color, personality,
   tier, capabilities, system prompt). Scope the prompt to the simulation; separate
   stable instructions from task context.
3. **I/O schema** — define output + simulator `kind`; validate on receipt.
4. **Tools** — minimal `ROLE_PERMISSIONS[key]`; justify each. Never a broad copy.
5. **Model/budget** — lowest adequate tier; guards apply via `runAgent`.
6. **Timeouts/retries** — rely on `checkLoop`/`checkBudget`; bound custom loops.
7. **Memory** — safe summaries only. **Handoffs** — `sendMessage` types.
8. **Success/failure states**; **evals** (shape, tool-selection, injection-refusal).
9. **Integrate** — appears via `createCompany`, emits events, audited.
10. Verify end-to-end.

## Workflow (tool)
Add to `ALL_TOOLS` (`area.verb`) → grant minimal roles → implement via
`callTool(ctx, tool, args, impl)` validating args + timeout/idempotency → permission
test → docs.

## Files to inspect
`src/lib/agents/definitions.ts`, `permissions.ts`, `tools.ts`, `orchestrator.ts`,
`memory.ts`, `messaging.ts`; tests `definitions.test.ts`, `permissions.test.ts`.

## Security
Least privilege; a model requesting a tool does not authorize it (`callTool`
decides); validate tool args; keep attack-capable roles scoped to the simulation.

## Validation
`npm run typecheck && npm test` incl. the new permission/definition assertions.

## Definition of done
Agent/tool defined, minimal allowlist, evals + tests green, integrated + audited,
docs updated.

## Final report
What was added · the allowlist (and justification) · evals/tests run + results ·
docs updated.

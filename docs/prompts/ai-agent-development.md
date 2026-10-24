# Prompt: adding a new AI employee

**When to use** — add an agent to the registry with tools, permissions, memory,
UI, audit, and evals.

**What to provide** — the agent's responsibility, the tools it needs, and its I/O.

## The prompt

```
Use the `aura-ai-agent` skill. Add a new AI employee to AURA:

RESPONSIBILITY: [ONE_CLEAR_JOB]
NEEDED TOOLS: [TOOLS_OR_"minimal"]
INPUT/OUTPUT: [WHAT_IT_CONSUMES_AND_PRODUCES]
MODEL TIER: [FAST|STANDARD|REASONING or "you choose lowest adequate"]

First confirm no existing agent (src/lib/agents/definitions.ts, 12 agents) already
covers this. Then:
1. Add an AgentDef (key, name, role, avatar, color, personality, tier,
   capabilities, system prompt). The prompt must scope all actions to the isolated
   simulation and separate stable instructions from task context.
2. Define the structured output + the simulator `kind`; validate output on receipt.
3. Add a ROLE_PERMISSIONS entry with the MINIMUM tools — justify each; never copy a
   broad allowlist.
4. Decide memory (safe summaries only) and handoffs (sendMessage types).
5. Add eval cases: output shape, tool-selection within allowlist, and an
   injection-refusal case (prompt tries to call a tool it isn't allowed → refused).
6. Add definitions.test.ts + permissions.test.ts assertions.
7. Verify it instantiates via createCompany, emits events, and is audited.

RUN npm run typecheck && npm test. Report results. Update
docs/security/agent-permissions.md.
```

## Expected deliverables
`AgentDef` + permissions + tests + evals; the agent appears in new companies and
shows in the roster/activity.

## Verification
Tests green; a dry run shows the agent acting within its allowlist and refusing
out-of-scope tools.

## Common failure modes
Over-broad permissions; unconstrained prompt; no injection/permission test; output
not validated.

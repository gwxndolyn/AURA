# Workflow: adding an AI employee

Skill: `aura-ai-agent`. Runtime: [../architecture/agent-orchestration.md](../architecture/agent-orchestration.md).

1. **Responsibility** — one clear job. Does an existing agent cover it? If so, don't
   add one.
2. **Identity** — add an `AgentDef` to `src/lib/agents/definitions.ts`: `key`,
   `name`, `role`, `avatar`, `color`, `personality`, `tier`, `capabilities`, and a
   **system prompt** (stable identity + constraints; scope to the simulation).
3. **I/O schema** — define the structured output you expect and the `kind` the
   simulator should mirror. Validate output on receipt.
   ([structured-outputs](../ai-engineering/structured-outputs.md))
4. **Allowed tools** — add a `ROLE_PERMISSIONS[key]` entry with the **minimum**
   tools. Never copy a broad allowlist for convenience.
   ([agent-permissions](../security/agent-permissions.md))
5. **Model & budget** — pick the lowest adequate `tier`
   ([model-routing](../ai-engineering/model-routing.md)); the daily budget +
   loop guards apply automatically via `runAgent`.
6. **Timeouts/retries** — rely on `checkLoop`/`checkBudget`; bound any custom loop.
7. **Memory** — decide what the agent should `remember` (safe summaries only).
8. **Handoffs** — define which agents it messages (`sendMessage` types).
9. **Success/failure states** — what DONE and recoverable-failure look like.
10. **Evaluations** — add eval cases (shape, tool-selection, security-refusal).
    ([evaluation-and-testing](../ai-engineering/evaluation-and-testing.md))
11. **Integrate** — ensure it appears in the roster (seeded via `createCompany`
    which instantiates all `AGENT_DEFS`), emits events, and is audited.
12. **Verify** the full workflow end-to-end.

Add a `definitions.test.ts` assertion (unique key/color/tier; constrained prompt
for any attack-capable role) and a `permissions.test.ts` assertion for its tools.

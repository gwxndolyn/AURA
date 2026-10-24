# Agent orchestration

The agent runtime lives in `src/lib/agents/`. It is deliberately simple: a single
**agent turn** is the unit; higher-level behavior is composed in
`src/lib/workflows/`.

## The registry (`definitions.ts`)

13 agents (12 original + `designer`), each an `AgentDef { key, name, role, avatar, color, personality, tier,
capabilities, systemPrompt }`. Lookup via `getAgentDef(key)` / `AGENT_BY_KEY`.

| key | name | role | tier |
|---|---|---|---|
| `ceo` | Ada | AI CEO / Strategy | REASONING |
| `product-manager` | Maya | Product Manager | STANDARD |
| `designer` | Pixel | UX/UI Designer | STANDARD |
| `architect` | Kai | Software Architect | REASONING |
| `frontend-engineer` | Nova | Frontend Engineer | STANDARD |
| `backend-engineer` | Atlas | Backend Engineer | STANDARD |
| `devops` | Forge | DevOps / SRE | STANDARD |
| `qa-engineer` | Iris | QA Engineer | FAST |
| `security-engineer` | Sentinel | Security Engineer | REASONING |
| `red-team` | Ghost | Red Team | REASONING |
| `blue-team` | Shield | Blue Team | REASONING |
| `data-analyst` | Vega | Data Analyst | FAST |
| `support` | Echo | Customer Support | FAST |

## One agent turn (`orchestrator.runAgent`)

```ts
const result = await runAgent({
  companyId,
  agentKey: "backend-engineer",
  objective: task.title,
  kind: "code",            // simulator hint & output shape
  context: task.description,
  tier,                    // optional override of def.tier
});
```

Steps:
1. Load `AgentDef` + `Agent` row. **`checkBudget`** (daily hard-stop →
   `BudgetExceededError`) and `maybeWarnBudget`.
2. Set status `THINKING`, emit `AGENT_STARTED`.
3. Build a **focused** context: system prompt + a compact company snapshot +
   `retrieveContext(agentId, objective)` (top long-term + keyword-scored short-term
   memory) + inline `context` + the objective. It does **not** dump history.
4. Set `WORKING`, call `complete()` (routes by tier; simulator fallback).
5. Record an `AgentRun` (model, tier, tokens, cost, latency, status) and increment
   the agent's running totals.
6. Store a **safe summary** to memory (`remember`) — never raw chain-of-thought.
   `safeSummary` derives a human line from JSON output.
7. Emit `AGENT_COMPLETED` with usage meta; set status back to `IDLE`.

## Memory (`memory.ts`)

- `remember(agentId, content, kind="short", relevance=1)` — short memory is pruned
  to the 20 most recent.
- `retrieveContext(agentId, query)` — top 5 long-term by relevance + up to 4
  keyword-scored short-term. Keeps prompts small (see
  [../ai-engineering/context-engineering.md](../ai-engineering/context-engineering.md)).

## Tools & permissions

Agent tool calls go through `callTool(ctx, tool, args, impl)` (`tools.ts`), which
checks `isAllowed(agentKey, tool)` against `ROLE_PERMISSIONS` (`permissions.ts`),
writes a `ToolCall` audit row, and audits the call. A blocked call throws
`PermissionError` and is recorded. **The model choosing a tool does not authorize
it** — the runner is the authority. See
[../ai-engineering/tool-calling.md](../ai-engineering/tool-calling.md) and
[../security/agent-permissions.md](../security/agent-permissions.md).

## Composed behaviors (workflows)

- **Sequential quality gate:** `executeTask` → implement → build check → real
  sandbox tests → acceptance → DONE/REVIEW.
- **Self-healing loop:** `executeTaskSelfHealing` → test → QA `BUG_REPORT` → fix →
  rerun, bounded by `maxAttempts` (default 3), ends DONE or recoverable BLOCKED.
- **Supervisor/arbiter:** `resolveConflict` has the `architect` decide between two
  positions on evidence and records a `Decision`.
- **Reassignment:** `reassignFromUnavailable` moves an unavailable agent's open
  tasks to a fallback peer.
- **Handoffs:** structured `AgentMessage`s via `sendMessage` (`HANDOFF`,
  `BUG_REPORT`, …).

Prefer the simplest pattern that works (see
[../ai-engineering/agent-orchestration.md](../ai-engineering/agent-orchestration.md)).
Build new multi-agent flows with the `aura-autonomous-workflow` skill.

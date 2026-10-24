# Memory & retrieval

Different kinds of "memory" have different rules. Don't conflate them.

| Kind | What | Where | Authority |
|---|---|---|---|
| **Persistent application data** | companies, tasks, deployments, findings | Prisma models | source of truth |
| **Task state** | a task's status/attempts | `Task` fields | source of truth |
| **Conversation history** | agent turn narrative | `AgentRun.summary` | advisory |
| **Agent memory** | short/long bullets | `AgentMemory` | advisory, prunable |
| **Retrieved knowledge** | docs/snippets (if RAG added) | external/index | **untrusted** |
| **Audit history** | immutable record | `AuditLog`, `ToolCall` | evidence, append-only |

## Agent memory (`src/lib/agents/memory.ts`)

- `remember(agentId, content, kind="short", relevance=1)` — stores a bullet; short
  memory pruned to 20 most recent. Only **safe summaries** are stored (never raw
  chain-of-thought).
- `retrieveContext(agentId, query)` — top 5 long-term by relevance + up to 4
  keyword-scored short-term. This is what feeds the prompt.

### What's worth remembering

Durable, reusable facts (a decision made, a convention adopted, a recurring
failure), as a short line — not transcripts. If it belongs in application state
(a status, a metric), store it as data, not memory.

## Retrieval rules

- **Scope to the company/agent.** Never retrieve across tenants.
- **Score by relevance** to the current objective; keep the window small (see
  [context-engineering](context-engineering.md)).
- **Handle staleness** — prefer fresh application state over an old memory for
  anything factual; memory reflects what was true when written.
- **Untrusted retrieved content** (RAG/docs/web) is data, not instructions, and
  cannot override policy or authorization. Track its source.

## Correction & deletion

Users must be able to correct or remove stored information about them. Application
data is editable/deletable through its normal routes (cascade deletes from
`Company`). If you add user-facing agent memory, provide a path to view and delete
it — don't let memory become an unaccountable store.

## The hard rule

**Untrusted memory or retrieved content never overrides system policy or
authorization.** Permissions and tenant scope are enforced in code regardless of
what any memory says.

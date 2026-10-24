# Agent orchestration (how the AI team actually works)

Detailed internals: [architecture/agent-orchestration.md](architecture/agent-orchestration.md)
(single agent turn), [architecture/multi-agent-collaboration.md](architecture/multi-agent-collaboration.md)
(capabilities, contracts, handoffs, reviewer, repair).

## One model, many roles — stated plainly

Every role uses the **same provider** (Anthropic, via `src/lib/ai/claude.ts`)
with a role-specific system prompt, a routed tier (FAST / STANDARD /
REASONING) and its own **capability record**. Characters are not separate
intelligences. What makes roles different is enforced in code:

| Layer | File | Enforced how |
|---|---|---|
| Identity + prompt | `agents/definitions.ts` | 13 roles incl. `designer`, `reviewer` |
| Tool allowlist | `agents/permissions.ts` | `callTool()` refuses tools outside the role's list (audited) |
| Capability (task kinds, domains, context, budgets, retries, verification) | `agents/capabilities.ts` | planner assignment + registry self-check in tests |
| Output contracts | `agents/contracts.ts` | Zod per task kind; invalid output fails the attempt |
| Write scope | mission task `files` | `code.write` outside scope throws before anything is recorded |

A model response asking for more permissions changes nothing.

## Layers of orchestration

1. **Product scheduler** (`factory/scheduler.ts`) — backlog-level: dependency
   readiness, parallelism, file-conflict avoidance, dispatch, evidence-based
   settlement, repair items, escalation. See [product-lifecycle.md](product-lifecycle.md).
2. **Mission engine** (`missions/engine.ts`) — per task: plan versions,
   leases + heartbeats, retries for transient categories only, bounded repair
   rounds, approvals with payload hashes, cancellation checks before each call.
3. **Agent turn** (`agents/orchestrator.ts`) — budget hard-stop, safety
   pre-flight, prompt version, model call, run record, memory, events.

## Structured handoffs

Product brief → backlog items · design spec → HANDOFF artifact consumed by
downstream task keys · architecture artifact → implementation constraints ·
code change → test evidence · review findings → repair rounds / REPAIR items ·
release candidate → deployment request. All persisted and linked (artifact
`consumedBy`, item `evidence`, mission `MissionHandoff`).

## Without an API key

PM, designer and architect produce **deterministic templates**, labelled
`template` with the reason everywhere they appear. The engineer applies the
fixture's prepared repair candidates, labelled `simulated-candidate`. Tests,
probes, security checks and git operations are real either way. AURA never
presents simulated output as model output.

# AI engineering handbook — overview

How AURA integrates AI into a real software workflow, and the patterns you must
follow when extending it. Every page here is grounded in AURA's code.

## Where AI belongs — and where it doesn't

AURA mixes deterministic code and LLM reasoning on purpose. Draw the line clearly:

| Use **deterministic code** for | Use an **LLM** for |
|---|---|
| Authorization (`requireWorkspaceAccess`) | Ambiguous classification |
| Permissions (`ROLE_PERMISSIONS`) | Planning / breaking a goal into tasks |
| Budget limits (`checkBudget`) | Summarization |
| State transitions (task status, deploy stages) | Code assistance / design notes |
| **Security score** (`computeSecurityScore`) | Decisions that benefit from context |
| Prioritization math (`scoreTask`) | Narrative / explanation |

**The rule that governs all of AURA:** an LLM is never the authority on its own
permissions, its own budget, or security-critical state. Those are computed and
enforced in code. The model proposes; code disposes.

### Concrete examples in the codebase

- The security score is **computed from real findings/incidents/infra**
  (`src/lib/company/security.ts`), never asked of the model.
- A model *requesting* a tool does not run it — `callTool` checks the role
  allowlist first.
- Task prioritization is a pure formula (`scoreTask`); the model only supplies the
  1–5 inputs, which are bounded.
- A coding task reaches DONE only if **real tests pass** in the sandbox — the model
  can't declare success.

## The layers

| Layer | Deterministic or AI | AURA module |
|---|---|---|
| Application logic | deterministic | routes, `workflows/*` plumbing |
| AI reasoning | AI | `agents/orchestrator` → `ai/claude` |
| Workflow orchestration | deterministic (sequences AI steps) | `workflows/*` |
| Tool execution | deterministic (gated) | `agents/tools` |
| Data retrieval | deterministic + relevance | `agents/memory` |
| Human approval | deterministic gate | `workflows/approval` |

## Read next

| Topic | Doc |
|---|---|
| Keep business logic off one provider | [model-provider-abstraction](model-provider-abstraction.md) |
| Structure prompts | [prompt-engineering](prompt-engineering.md) |
| Validate model output | [structured-outputs](structured-outputs.md) |
| Gate tools safely | [tool-calling](tool-calling.md) |
| Choose an orchestration shape | [agent-orchestration](agent-orchestration.md) |
| Keep prompts small | [context-engineering](context-engineering.md) |
| Memory vs data vs history | [memory-and-retrieval](memory-and-retrieval.md) |
| Test probabilistic behavior | [evaluation-and-testing](evaluation-and-testing.md) |
| Cost & latency | [token-and-cost-management](token-and-cost-management.md) · [latency-and-reliability](latency-and-reliability.md) |
| Defend against injection | [prompt-injection-defense](prompt-injection-defense.md) |
| Human-in-the-loop | [human-approval](human-approval.md) |
| Ship checklist | [production-ai-checklist](production-ai-checklist.md) |

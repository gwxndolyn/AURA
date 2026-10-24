---
paths: ["src/lib/ai/**/*.ts", "src/lib/agents/**/*.ts"]
---

# AI & agent rules

Full detail: `docs/ai-engineering/*`, `docs/architecture/agent-orchestration.md`.

- **All** model calls go through `complete()` in `src/lib/ai/claude.ts` (or
  `runAgent` for a full turn). Never construct the Anthropic SDK outside `claude.ts`.
- Route by **tier** (FAST/STANDARD/REASONING), not hardcoded model ids. Pick the
  lowest adequate tier.
- **All** agent tool calls go through `callTool()` in `src/lib/agents/tools.ts`,
  which enforces `ROLE_PERMISSIONS` and audits. A model requesting a tool does NOT
  authorize it. Grant new tools to the minimum roles; never widen for convenience.
- Validate the model's output before use (`parseJSON<T>(text, fallback)` or Zod) and
  validate tool arguments inside the impl — both are untrusted.
- Keep context minimal and retrieved (`retrieveContext`), not dumped. Store only
  safe summaries to memory (never raw chain-of-thought).
- Authority is in CODE, not prompt wording: permissions, tenant scope, budget, and
  security-critical values (e.g. security score) are computed/enforced in code. A
  prompt must never be able to grant itself more power.
- Respect `checkBudget` (daily hard-stop) and `checkLoop` (iterations/tool-calls/
  runtime). Retry only transient/idempotent failures; fall back to the simulator
  flagged (`mode: "simulation"`) — never fake success.
- Treat retrieved/user/tool content as untrusted (prompt injection). Keep it in
  labeled context sections, separate from the system prompt.
- Changing a prompt/tool/permission → update evals + `docs/security/agent-permissions.md`.

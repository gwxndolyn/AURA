# Error handling

## Typed errors, one wrapper

| Error | Meaning | Thrown by / use for | HTTP |
|---|---|---|---|
| `AuthError(status, msg)` | authn/authz failure | `src/lib/auth/authz.ts` | 401 / 403 / 404 |
| `ApiError(msg, status)` | validation / business rule | your route or domain code | 400 / 422 / 404 / … |
| `PermissionError` | agent tool not permitted | `callTool` | surfaced in `ToolCall` + audit |
| `BudgetExceededError` | daily AI budget hit | `runAgent` | pause the agent |
| anything else | unexpected | — | logged `[api error]`, 500 |

`handler()` in `src/lib/api.ts` maps `AuthError`/`ApiError` to `err(msg, status)`
and everything else to a logged 500. **Routes throw; they don't try/catch.**

```ts
if (!task) throw new ApiError("Task not found", 404);
await requireWorkspaceAccess(id, "MEMBER");   // throws AuthError on its own
```

## Fallbacks are flagged, not disguised

AURA degrades gracefully but **never pretends** a fallback is the real thing:

- `complete()` falls back to the simulator on missing key / API error and sets
  `mode: "simulation"` (model string suffixed `(sim)` / `(fallback)`).
- The sandbox falls back to a simulated test result flagged `real: false`; a task
  is only reported "real sandbox" when it actually ran in Docker.

Do the same for any new fallback: return a mode/flag, emit an honest event, and let
callers see it. Never return a success shape for a failure.

## What not to do

- No empty `catch {}` that swallows errors (the only acceptable empty catch is the
  SSE `controller.enqueue` guard where the stream is already closed).
- No catch-all that turns a bug into a fake success.
- No arbitrary `sleep()` to "fix" a race — find the real ordering.
- No retrying non-idempotent operations, auth failures, or deterministic validation
  errors. Retry only transient, idempotent failures with backoff — see
  [../ai-engineering/latency-and-reliability.md](../ai-engineering/latency-and-reliability.md).

## Agent/workflow failures

Must not crash the company. Catch at the workflow boundary, emit an
`AGENT_FAILED`/`warning` event, set the entity to a recoverable state (e.g. task →
`REVIEW`/`BLOCKED`), and surface it in the UI (attention panel). The self-healing
loop (`selfHeal.ts`) is the model: bounded attempts, a `BUG_REPORT`, then a
recoverable `BLOCKED` — never an infinite retry.

## Logging

- Server errors: `console.error("[api error]", e)` (handler does this).
- State changes: `emitEvent`. Security-relevant actions: `audit`.
- Never log secrets, full API keys, or sensitive prompt/response content.

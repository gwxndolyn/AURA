# Latency & reliability

## Reliability model

- **Never crash the company on a model failure.** `complete()` catches API errors
  and falls back to the deterministic simulator, flagged `mode: "simulation"`.
- **Flag, don't fake.** Fallbacks carry a mode/flag so callers and the UI see the
  degraded path. A task is "DONE with real tests" only when Docker actually ran
  them.
- **Bound everything.** `checkLoop` caps iterations/tool-calls/runtime; `checkBudget`
  hard-stops on daily spend; the sandbox has a wall-clock timeout.

## Retry policy

Retry **only** transient, idempotent failures, with backoff. Do **not** retry:

- authorization failures (`AuthError`),
- deterministic validation errors (`ApiError`/Zod 422),
- non-idempotent operations without an idempotency guard.

The self-heal loop (`selfHeal.ts`) and `deployWithRetry` are the AURA patterns:
bounded attempts (`maxAttempts`/`maxRetries`), a real check between attempts, and a
recoverable terminal state (`BLOCKED`/`FAILED`) when exhausted — never infinite.

## Timeouts

- Sandbox exec: `AURA_SANDBOX_TIMEOUT_MS` (default 20s) + 5s teardown, enforced on
  the host.
- Long AI routes raise `maxDuration` (60/120/300). Keep user-facing requests fast;
  push long work to fire-and-forget with SSE progress (the `demo` route).
- Any external/tool call you add needs an explicit timeout.

## Latency levers

- Lower tier for simple tasks ([model-routing](model-routing.md)).
- Smaller context ([context-engineering](context-engineering.md)).
- Parallelize independent calls (`Promise.all`).
- Stream progress via SSE so the UI feels responsive even when work is long
  (events, not token streaming, today).
- The simulator adds a small artificial latency so the UI shows realistic
  "thinking" — don't mistake that for the live path.

## Circuit-breaking

If you add a flaky external dependency, wrap it with a timeout + bounded retry and
degrade to a flagged fallback (the model-call pattern). Don't let one slow
dependency stall the whole workflow.

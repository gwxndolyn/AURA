# Workflow: adding background / long-running work

AURA has **no job queue**. Choose the right pattern; detail in
[../architecture/events-and-jobs.md](../architecture/events-and-jobs.md).

## Decide the pattern

| Need | Pattern |
|---|---|
| Finishes within a request | In-request; raise `maxDuration` (60/120/300). |
| Best-effort, user watches progress | Fire-and-forget IIFE after responding (the `demo` route), stream via SSE. |
| Periodic/world advancement | UI-driven tick (`sim-controls` → `/sim` → `tickDay`). |
| **Must complete reliably** | Durable workflow — persist state in the DB; `aura-autonomous-workflow` skill. |

## Fire-and-forget (best-effort) recipe

```ts
export const maxDuration = 120;
export const POST = handler(async (req, ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  // start, then respond immediately:
  (async () => {
    try { /* steps, each emitEvent(...) */ }
    catch (e) { await emitEvent({ companyId: id, type: "AGENT_FAILED", level: "danger", message: String(e) }); }
  })();
  return ok({ started: true });
});
```

Caveats: a crash or scale-to-zero loses it; don't use for anything that must
complete. Bound it with `checkBudget`/`checkLoop`.

## Durable work

Persist an explicit state machine (status column), make each step idempotent, bound
retries, support cancellation + timeouts, add approval gates for consequential
actions, emit audit events, and add integration tests (mirror `runStressTest`
invariants). See [adding an autonomous workflow](adding-a-feature.md) via the
`aura-autonomous-workflow` skill.

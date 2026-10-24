# Events & background jobs

## Event bus (`src/lib/events/bus.ts`)

An in-process Node `EventEmitter` cached on `globalThis.auraBus` (survives HMR;
`maxListeners` 1000). No Redis required.

```ts
publish(event: LiveEvent): void                       // emits on "event" and "event:<companyId>"
subscribe(companyId, handler): () => void             // returns unsubscribe
```

Because it is in-process, it works for a single server instance only. Multi-process
streaming would need a Redis-backed bus (left as a documented next step).

## Emitting (`src/lib/events/emit.ts`)

Always emit through `emitEvent` — never write `SimulationEvent` rows directly:

```ts
await emitEvent({
  companyId,
  type: "TASK_UPDATED",            // one of EventType (22 values, src/lib/types.ts)
  actor: "backend-engineer",       // agent key → actorName/role auto-attached via getAgentDef
  message: "Started: Add login",
  level: "info",                   // info | success | warning | danger
  meta: { taskId },                // JSON-stringified on persist
  persist: true,                   // default true → writes a SimulationEvent row
});
```

`emitEvent` persists (unless `persist:false`, used for high-frequency ticks like
`SIM_TICK`/`AGENT_THINKING`) and publishes to the bus. The SSE route streams
published events to the browser; `useLiveEvents` renders them.

`audit(companyId, actor, action, target, result)` appends an immutable `AuditLog`
row — use it for security-relevant actions (tool calls do this automatically via
`callTool`).

## Event types

`AGENT_STARTED/THINKING/TOOL_CALL/COMPLETED/FAILED`, `TASK_CREATED/UPDATED`,
`CODE_CHANGED`, `TEST_STARTED/COMPLETED`, `DEPLOYMENT_STARTED/COMPLETED`,
`ATTACK_STARTED/DETECTED`, `INCIDENT_CREATED/RESOLVED`,
`VULNERABILITY_FOUND/PATCHED`, `SIM_TICK`, `COMPANY_UPDATED`, `DECISION_CREATED`,
`CHAT`. Adding one? Extend `EventType` in `src/lib/types.ts`.

## "Jobs" — there is no queue

AURA has no background worker. Three patterns cover long work:

1. **In-request** with a raised `maxDuration` (e.g. `execute`, `approve` use 60s).
2. **Fire-and-forget** after responding — the reference is `api/demo/route.ts`:

   ```ts
   return ok({ companyId });        // respond immediately
   (async () => { /* long multi-step demo, each step emits events */ })();
   ```

   The browser follows progress over SSE. Only safe for best-effort work (a crash
   or scale-to-zero loses it). Don't use it for anything that must complete.
3. **UI-driven ticks** — the simulation advances via `sim-controls` on the client
   calling the `/sim` route (`tickDay`), keeping the app serverless-safe.

For durable multi-step work, follow the `aura-autonomous-workflow` skill:
explicit states persisted in the DB, idempotent steps, bounded retries, approval
gates, and audit events — not an uncontrolled loop of model calls.

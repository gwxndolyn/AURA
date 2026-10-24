# Backend patterns

See [../architecture/backend.md](../architecture/backend.md) for the layering. This
is the "how to write it" cheat sheet.

## A domain function

```ts
// src/lib/workflows/myThing.ts
import { prisma } from "@/lib/db";
import { emitEvent, audit } from "@/lib/events/emit";

export async function doMyThing(companyId: string, input: MyInput) {
  // 1. read scoped state
  const rows = await prisma.task.findMany({ where: { companyId, status: "BACKLOG" } });
  // 2. do the work (pure logic extracted + unit-tested where possible)
  const result = compute(rows, input);
  // 3. persist
  await prisma.task.updateMany({ where: { companyId, id: { in: result.ids } }, data: { ... } });
  // 4. emit + audit side effects
  await emitEvent({ companyId, type: "TASK_UPDATED", message: `...`, meta: { ...result } });
  return result;
}
```

- First arg is `companyId`. Own your Prisma access + events here, not in the route.
- Extract pure logic (like `scoreTask`) so it's unit-testable without a DB.

## Calling the model

```ts
import { runAgent } from "@/lib/agents/orchestrator";
const r = await runAgent({ companyId, agentKey: "architect", objective, kind: "architecture", context });
// r.text (raw), r.summary (safe), r.cost/tokens/mode
```

Use `runAgent` (not `complete` directly) when you want the full turn — status,
memory, run record, events, budget guard. Use `complete()` directly only for a
one-off model call with no agent identity.

## Calling a tool

```ts
import { callTool } from "@/lib/agents/tools";
await callTool({ companyId, agentKey: "devops", runId }, "deploy.run", { env }, async () => {
  return actuallyDeploy(env);   // the impl only runs if the role is permitted
});
```

## Reading JSON columns

```ts
import { parseJSON } from "@/lib/utils";
const stages = parseJSON<Stage[]>(deployment.stages, []);
const files = parseJSON<Record<string, string>>(ws.files, {});
```

## Scoping & IDOR

```ts
// nested id → ALWAYS scope by companyId
const task = await prisma.task.findFirst({ where: { id: taskId, companyId } });
if (!task) throw new ApiError("Not found", 404);
```

## Budget & guardrails

`runAgent` already calls `checkBudget`. For custom loops, use `newGuardState()` +
`checkLoop(state)` from `@/lib/agents/guardrails` and bump `state.iterations` /
`state.toolCalls` each step. Stop on a non-ok verdict.

## Long work

No queue. In-request (raise `maxDuration`) or fire-and-forget after responding (the
`demo` route) — see [../architecture/events-and-jobs.md](../architecture/events-and-jobs.md).
For durable multi-step work use the `aura-autonomous-workflow` skill.

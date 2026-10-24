# Tool calling

**The model selecting a tool does not authorize it.** The server independently
verifies the action and its permissions. In AURA that server is
`callTool()` in `src/lib/agents/tools.ts`.

## The runner

```ts
export async function callTool<T>(
  ctx: { companyId; agentKey; runId? },
  tool: string,
  args: Record<string, unknown>,
  impl: () => Promise<T>,
): Promise<T>
```

What it guarantees:

1. **Authorization** — `isAllowed(agentKey, tool)` against `ROLE_PERMISSIONS`
   (`permissions.ts`). A denied call throws `PermissionError`, writes a failed
   `ToolCall`, and audits `TOOL_DENIED`. The `impl` never runs.
2. **Audit** — every call (ok or fail) writes a `ToolCall` row (tool, args, output,
   `ok`, truncated to 4000 chars) tied to the `runId`, plus an `audit` entry with
   duration.
3. **Error propagation** — the `impl`'s error is recorded and rethrown, not
   swallowed.

## The tools & allowlists

`ALL_TOOLS` (18): `planning.createTask|prioritize|createSprint`,
`code.read|write|build`, `sandbox.exec`, `test.run`, `browser.qa`,
`security.scan|patch`, `logs.read`, `deploy.run|rollback`, `cyber.attack`
(red team only), `cyber.monitor` (blue team), `incident.manage`, `message.send`.

Per-role allowlists are in `ROLE_PERMISSIONS`. Examples: only engineers get
`code.write`; only `devops` gets `deploy.run`/`deploy.rollback`; only `red-team`
gets `cyber.attack`; every role gets `message.send`; unknown agents get just
`message.send`.

## Adding a tool

Use the `aura-ai-agent` skill. Steps:

1. Add the tool name to `ALL_TOOLS` (namespaced `area.verb`).
2. Grant it to the **minimum** roles in `ROLE_PERMISSIONS` — never to all.
3. Call it through `callTool(ctx, "area.verb", args, impl)`. Validate `args`
   (Zod/`parseJSON`) **inside** the impl — don't trust the model's arguments.
4. Make the impl **idempotent** where possible, with a **timeout** for anything
   external (sandbox exec already has one). Bound tool calls with the loop guard.
5. Add a permission test (mirror `permissions.test.ts`): the roles that should be
   denied are denied.
6. Document it here and in [../security/agent-permissions.md](../security/agent-permissions.md).

## Rules

- Least privilege: grant the fewest roles. Don't widen for convenience.
- Validate arguments server-side; the model's args are untrusted input.
- Enforce timeouts and (where relevant) idempotency; record an audit row (automatic
  via `callTool`).
- Limit tool-result size fed back into context (the runner truncates stored output;
  do the same for what you return into the next prompt).
- Respect the tool-call budget (`checkLoop`).

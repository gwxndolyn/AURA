# Agent permissions

Least privilege for AI employees. Source of truth: `src/lib/agents/permissions.ts`;
enforcement: `src/lib/agents/tools.ts` (`callTool`).

## Model

- `ALL_TOOLS` — the namespaced tool catalog (18 tools).
- `ROLE_PERMISSIONS: Record<agentKey, ToolName[]>` — explicit allowlist per role.
- `permissionsFor(key)` → the role's tools (unknown roles get `["message.send"]`).
- `isAllowed(key, tool)` → boolean, used by `callTool`.

A tool only executes if `isAllowed(agentKey, tool)`. A denied call throws
`PermissionError`, records a failed `ToolCall`, and audits `TOOL_DENIED` — the impl
never runs. **The model choosing a tool does not authorize it.**

## Current allowlists (verified)

| Role | Tools |
|---|---|
| `ceo` | planning.prioritize, planning.createSprint, message.send |
| `product-manager` | planning.createTask/prioritize/createSprint, message.send |
| `architect` | code.read, planning.createTask, message.send |
| `frontend-engineer` | code.read/write/build, sandbox.exec, message.send |
| `backend-engineer` | code.read/write/build, sandbox.exec, security.patch, message.send |
| `qa-engineer` | code.read, test.run, browser.qa, sandbox.exec, message.send |
| `reviewer` | code.read, sandbox.exec, message.send (never writes code) |
| `devops` | deploy.run, deploy.rollback, logs.read, sandbox.exec, message.send |
| `security-engineer` | security.scan, security.patch, logs.read, incident.manage, message.send |
| `red-team` | **cyber.attack**, message.send |
| `blue-team` | cyber.monitor, logs.read, incident.manage, message.send |
| `data-analyst` | logs.read, message.send |
| `support` | message.send |

Invariants (tested in `permissions.test.ts`): red-team can attack but **not**
deploy; only engineers write code; only devops deploy/rollback; every role can
message; unknown agents get the minimal allowlist.

## Rules

- **Grant the fewest roles** a new tool needs. Never add a tool to every role, and
  never widen an allowlist to make an implementation easier.
- Red-team's single powerful capability (`cyber.attack`) is scoped to the
  **simulated** range by prompt and by code — don't extend it.
- Validate tool arguments inside the impl; the model's args are untrusted.
- Changing an allowlist is a security change → update this table and add/adjust the
  permission test. See [../ai-engineering/tool-calling.md](../ai-engineering/tool-calling.md).

## Auditing

Every tool call (allowed or denied) writes a `ToolCall` row + an `AuditLog` entry.
Review via `/api/companies/[id]/audit`. Denied calls are your injection/abuse
signal.


## Tool specs (argument/result validation, scope, timeouts)

`src/lib/agents/toolSpecs.ts` gives each tool an input schema, output schema
and timeout; `callTool()` enforces them. `code.write` is refused outside the
calling task's write scope; `deploy.run`/`deploy.rollback` are refused without
an APPROVED approval id. Failures are recorded on the `ToolCall` row with a
status (`denied`, `invalid_args`, `out_of_scope`, `timeout`, `error`,
`invalid_output`, `approval_required`). The capability registry
(`capabilities.ts`) can only narrow the role allowlist, never widen it.

# Workflow: adding an agent tool

Skill: `aura-ai-agent`. Detail: [../ai-engineering/tool-calling.md](../ai-engineering/tool-calling.md).

1. **Name it** `area.verb` and add to `ALL_TOOLS` in
   `src/lib/agents/permissions.ts`.
2. **Grant minimally** — add it to only the roles that need it in
   `ROLE_PERMISSIONS`. Never all roles.
3. **Implement via `callTool`**:

   ```ts
   await callTool({ companyId, agentKey, runId }, "area.verb", args, async () => {
     const input = Schema.parse(args);     // validate the model's args
     // ... do the work (idempotent where possible, with a timeout) ...
     return result;
   });
   ```

4. **Validate arguments** inside the impl — the model's args are untrusted.
5. **Timeout + idempotency** for anything external; keep returned output small
   (truncate before re-injecting into context).
6. **Audit** is automatic (`callTool` writes a `ToolCall` + `AuditLog`).
7. **Test** — a `permissions.test.ts` assertion that disallowed roles are denied,
   and a behavior test of the impl.
8. **Docs** — update the tool table in
   [../security/agent-permissions.md](../security/agent-permissions.md) and
   `tool-calling.md`.

Remember: **a model requesting the tool does not authorize it** — the runner's
allowlist check is the authority.

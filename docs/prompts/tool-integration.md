# Prompt: tool integration

**When to use** — add a new agent tool.

**What to provide** — what the tool does, which roles need it, its arguments.

## The prompt

```
Use the `aura-ai-agent` skill (tool section). Add an agent tool to AURA.

TOOL: [area.verb — WHAT_IT_DOES]
ROLES THAT NEED IT: [MINIMAL_ROLE_LIST]
ARGUMENTS: [ARG_SCHEMA]

1. Add the name to ALL_TOOLS in src/lib/agents/permissions.ts (namespaced area.verb).
2. Grant it to the MINIMUM roles in ROLE_PERMISSIONS — justify each; never all.
3. Implement via callTool({companyId, agentKey, runId}, "area.verb", args, impl).
   Inside impl: validate args with Zod (the model's args are untrusted), add a
   timeout, make it idempotent where possible, keep returned output small.
4. Audit is automatic (ToolCall + AuditLog). Propagate errors, don't swallow.
5. Add a permissions.test.ts assertion that disallowed roles are denied + a behavior
   test of the impl.
6. RUN npm run typecheck && npm test. Update docs/security/agent-permissions.md and
   docs/ai-engineering/tool-calling.md.

Remember: the model selecting a tool does NOT authorize it — callTool's allowlist
check is the authority.
```

## Expected deliverables
Tool in `ALL_TOOLS` + minimal allowlist + validated impl via `callTool` + tests +
docs.

## Verification
Permission test shows denied roles blocked and audited; behavior test passes.

## Common failure modes
Granting to all roles; trusting the model's args; no timeout; missing permission test.

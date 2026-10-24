# Threat model

A pragmatic model for AURA. AURA is a simulation, but the application code is real
and multi-tenant, so the app surface deserves real controls. Cross-ref
[../../SECURITY.md](../../SECURITY.md).

## Assets

- Workspace data (companies, tasks, deployments, findings, metrics) — tenant-scoped.
- User credentials & sessions.
- `ANTHROPIC_API_KEY` and any provider secret (server-only).
- Agent tool capabilities (deploy, patch, attack-in-range, messaging).
- The execution sandbox (runs untrusted generated code).

## Trust boundaries

| Boundary | Untrusted side | Control |
|---|---|---|
| Browser → API | client (incl. auth claims) | `requireWorkspaceAccess`, Zod, middleware |
| User input / AI output → state | both untrusted | Zod / `parseJSON`, computed security values |
| Model → tool execution | model's choice & args | `callTool` permission check + arg validation |
| Generated code → host | code is hostile | Docker sandbox (`--network none`, caps dropped) |
| Tenant A ↔ Tenant B | each other | `companyId` scoping, `findFirst({id,companyId})` |
| Retrieved/memory content → prompt | content | treat as data; authority in code |

## Top threats & mitigations

1. **IDOR / cross-tenant access** → `requireWorkspaceAccess` (404, no leak) +
   `findFirst({ id, companyId })`. Tested in `isolation.test.ts`.
   ([tenant-isolation](tenant-isolation.md))
2. **Broken authz** (frontend-only checks) → backend is authority; `middleware.ts`
   gates `/app` + `/api/companies`.
3. **Prompt injection → tool abuse / excessive agency** → permissions enforced
   server-side; a prompt can't grant a tool.
   ([../ai-engineering/prompt-injection-defense](../ai-engineering/prompt-injection-defense.md),
   [agent-permissions](agent-permissions.md))
4. **Unsafe generated-code execution / sandbox escape** → locked-down container,
   path sanitization, no network, non-root, resource/pid/time limits.
   ([sandbox-security](sandbox-security.md))
5. **Secret exposure / exfiltration** → server-only key, no `NEXT_PUBLIC_` on
   secrets, sandbox has no network and no secret mounts, no secret logging.
   ([secret-management](secret-management.md))
6. **Injection (SQLi/XSS/SSRF/path/command)** → Prisma (no raw SQL), React escaping,
   no untrusted URL fetches server-side, `sanitizeRel` for workspace paths, no shell
   with untrusted input outside the sandbox.
7. **Budget/DoS via runaway agents** → `checkBudget` hard-stop + `checkLoop`.
8. **Dependency vulnerabilities** → keep deps minimal; `npm audit`; Next pinned off
   a known CVE (≥15.5.4).

## Out of scope / simulated

- The red/blue cyber range runs **simulated** attacks against in-process toy
  targets. It performs no real exploitation and reaches no external system — by
  prompt and by code. Never point range tooling at a real system.

## Reviewing a security-sensitive change

Use the `aura-security-audit` skill and [secure-development](secure-development.md).
Rank findings by severity × likelihood × impact; verify with a safe test; never
attack a real system.

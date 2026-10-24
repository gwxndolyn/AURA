# Security policy

AURA is an educational **simulation**. All financial, customer, and security data
is fictional. The red team only ever targets AURA's own in-process toy targets —
it has no capability (by prompt and by code) to reach any real or external system.

## Reporting a vulnerability

This is a sample/educational project (MIT). If you find a real security issue in
the code (not the simulated scenarios), open a private report to the maintainers
rather than a public issue. Include repro steps and affected files.

## Security model (what protects what)

| Concern | Control | Where |
|---|---|---|
| Multi-tenant access | `requireWorkspaceAccess(companyId, role)` — the single choke point; denies cross-workspace with 404 (no existence leak) | `src/lib/auth/authz.ts` |
| IDOR on nested ids | `findFirst({ where: { id, companyId } })` everywhere | all company routes |
| AuthN | scrypt password hashes; HMAC-signed httpOnly cookie sessions | `src/lib/auth/password.ts`, `session.ts`, `edge.ts` |
| Route gating | `middleware.ts` blocks unauth `/app` + `/api/companies` | `src/middleware.ts` |
| Agent least-privilege | per-role tool allowlists enforced by the tool runner + audited | `src/lib/agents/permissions.ts`, `tools.ts` |
| Untrusted code execution | locked-down Docker sandbox (`--network none`, caps dropped, non-root, limits) | `src/lib/sandbox/` |
| Secrets | `ANTHROPIC_API_KEY` server-only; never `NEXT_PUBLIC_` | `.env`, `src/lib/ai/claude.ts` |
| Input validation | Zod at every API boundary | `src/lib/api.ts` + route schemas |
| Prompt injection | treat retrieved/user/tool content as untrusted; permissions enforced server-side, not by prompt | see below |
| Budget abuse | daily hard-stop + loop guard | `src/lib/agents/guardrails.ts` |
| Audit | immutable `AuditLog` + `ToolCall` records | `src/lib/events/emit.ts`, `tools.ts` |

## Non-negotiable rules

- Never bypass `requireWorkspaceAccess` or query a company resource without
  `companyId` scope.
- Never trust frontend authorization — the backend is the authority.
- Never let an LLM be the authority on its own permissions. A model *requesting* a
  tool does not authorize it; `callTool` independently checks.
- Never execute generated/untrusted code outside the sandbox.
- Never relax the sandbox container flags to make something "work".
- Never log secrets or full prompts/outputs containing sensitive data.
- Never widen an agent's permissions for convenience.

## Deep dives

- Threat model: [docs/security/threat-model.md](docs/security/threat-model.md)
- Agent permissions: [docs/security/agent-permissions.md](docs/security/agent-permissions.md)
- Tenant isolation: [docs/security/tenant-isolation.md](docs/security/tenant-isolation.md)
- Sandbox security: [docs/security/sandbox-security.md](docs/security/sandbox-security.md)
- Secret management: [docs/security/secret-management.md](docs/security/secret-management.md)
- Secure development: [docs/security/secure-development.md](docs/security/secure-development.md)
- Prompt-injection defense: [docs/ai-engineering/prompt-injection-defense.md](docs/ai-engineering/prompt-injection-defense.md)

## Known limitations (by design)

- Single local user by default (`founder@aura.local`) when auth isn't exercised;
  the multi-tenant model exists and is tested (`src/lib/auth/isolation.test.ts`).
- Deployment is a simulated pipeline; nothing ships to a real host.
- The in-process event bus is single-instance; multi-process needs Redis.

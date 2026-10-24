---
paths: ["src/lib/auth/**/*.ts", "src/middleware.ts", "src/lib/sandbox/**/*.ts", "src/lib/agents/permissions.ts", "src/lib/agents/tools.ts"]
---

# Security rules

Full detail: `docs/security/*`, `SECURITY.md`.

- `requireWorkspaceAccess(companyId, role)` is the multi-tenant choke point. It
  denies non-members with **404** (no existence leak). Call it first; never bypass.
- Enforce access in CODE, never in the client or a prompt. Frontend checks are
  cosmetic.
- Nested resource ids: `findFirst({ where: { id, companyId } })`. A `findUnique` by
  id alone on a company resource is an IDOR bug.
- Agent tools: least privilege. `ROLE_PERMISSIONS` is the allowlist; `callTool`
  enforces + audits it. A model selecting a tool does not authorize it. Validate
  tool args (untrusted). Never widen an allowlist for convenience.
- Sandbox: untrusted/generated code runs ONLY in the Docker sandbox. Never weaken
  its flags (`--network none`, `--cap-drop ALL`, non-root, limits). Writes go
  through `sanitizeRel`. No secrets in the sandbox.
- Secrets: server-only; never `NEXT_PUBLIC_` a secret; never log one. Passwords are
  scrypt-hashed; sessions are HMAC-signed httpOnly cookies.
- Any security-relevant change needs a test that proves the control blocks the bad
  case (cross-workspace 404, denied tool, rejected input) + a threat-model/doc update.
- Cyber range is an ISOLATED simulation — never target a real system.

---
name: aura-security-audit
description: Audit AURA application and AI security — authz, tenant isolation/IDOR, secrets, injection (SQLi/XSS/SSRF/path/command/prompt), tool abuse, unsafe code execution, deps — with severity-ranked, verified findings and safe regression tests. Use for a security pass.
---

# aura-security-audit

## When to use
Auditing a change or an area for security issues; verifying a security-sensitive
change.

## Required context
`docs/security/*`, `docs/ai-engineering/prompt-injection-defense.md`, `SECURITY.md`.

## Review checklist
authn · authz · **tenant isolation** (`companyId` scoping; IDOR via `findUnique`) ·
secrets (no `NEXT_PUBLIC_`; no logging) · input validation (Zod) · SQLi (Prisma —
flag any raw SQL) · XSS · SSRF · command injection · path traversal (workspace
`sanitizeRel`) · **prompt injection** · tool abuse / excessive agency · unsafe
generated-code execution / weakened sandbox flags · dependency vulns (`npm audit`) ·
sensitive logging.

## Workflow
1. Enumerate the scope; read the real code.
2. For each finding: severity (Critical/High/Medium/Low) × likelihood × impact,
   exact `file:line`, and a **safe** regression test proving it.
3. Verify with safe tests where possible; re-test after a fix.
4. Rank most-severe first. If an area is clean, say so.

## Hard rules
- NEVER launch attacks against real external systems. The cyber range is an
  isolated simulation only.
- Don't invent issues to pad the report.

## Validation
Each finding reproduced by a safe test; `npm test` for added tests.

## Definition of done
Ranked verified findings with file:line and safe tests; honest "clean" where true;
fixes re-tested.

## Final report
Findings ranked by severity (file:line + failure scenario + fix) · what was verified
· anything unverified.

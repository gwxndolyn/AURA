# Prompt: security audit

**When to use** — audit app + AI security of a change or an area.

**What to provide** — the scope (files/area) and any specific concern.

## The prompt

```
Use the `aura-security-audit` skill. Audit AURA for security issues.

SCOPE: [FILES_OR_AREA, or "the current diff"]
CONCERN (optional): [SPECIFIC_WORRY]

Review for: authn/authz, tenant isolation (companyId scoping, IDOR via findUnique),
secret handling (no NEXT_PUBLIC_ secrets, no secret logging), input validation
(Zod), SQLi (should be impossible via Prisma — flag any raw SQL), XSS, SSRF,
command injection, path traversal (workspace sanitizeRel), prompt injection, tool
abuse / excessive agency, unsafe generated-code execution / sandbox-flag weakening,
dependency vulns, sensitive logging.

For each finding: severity (Critical/High/Medium/Low) × likelihood × impact, exact
file:line, and a SAFE regression test that proves it. Verify findings with safe
tests where possible. Rank most-severe first. If an area is clean, say so — do not
invent issues to pad the report.

NEVER launch attacks against real external systems. For the cyber range, operate
only against the isolated simulation.
```

## Expected deliverables
A ranked, verified findings list with file:line and safe tests; honest "clean"
where applicable.

## Verification
Each finding reproduced by a safe test; fixes re-tested.

## Common failure modes
Padding with invented issues; no severity ranking; no verification; touching real
systems.

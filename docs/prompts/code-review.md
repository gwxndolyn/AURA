# Prompt: code review

**When to use** — review a change as a senior engineer.

**What to provide** — the diff/PR/branch or files to review.

## The prompt

```
Use the `aura-code-review` skill (or /code-review). Review this change in AURA:

TARGET: [DIFF / PR# / BRANCH / FILES]

Review in priority order: correctness; security & tenancy (companyId scoping, IDOR
via findUnique, requireWorkspaceAccess role, no NEXT_PUBLIC_ secrets, Zod
validation, untrusted-content handling); architecture (logic in lib, choke points
used, no duplication); data integrity (safe migrations, parseJSON fallbacks);
error handling (typed errors, no swallowed catches, flagged fallbacks); concurrency
(no floating promises); performance (N+1, redundant model calls, oversized
context); tests (right type, runnable, IDOR/permission coverage, actually run);
maintainability; regressions.

For each finding: severity (Critical/High/Medium/Low) and exact file:line. Rank
most-severe first. Do NOT invent problems to lengthen the report — if it's clean,
say so.
```

## Expected deliverables
A ranked findings list with file:line; a clear verdict.

## Verification
Each finding is real and reproducible; nothing invented.

## Common failure modes
Nitpicking style over correctness/security; padding; missing the IDOR/permission gaps.

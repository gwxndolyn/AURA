# Prompt: Claude Code session handoff

**When to use** — end of a working session; hand off cleanly to a fresh session.

**What to provide** — nothing; it summarizes the current session.

## The prompt

```
Produce a session handoff for the next Claude Code session on AURA. Include:

1. COMPLETED: what was done this session (feature/fix/refactor), with the real
   files changed.
2. ARCHITECTURE FINDINGS: anything non-obvious you learned about the codebase that
   isn't already in docs/ or CLAUDE.md (and whether it should be saved to memory).
3. MODIFIED FILES: the exact list, grouped by area.
4. TEST RESULTS: the commands you ran (npm run typecheck / lint / test / test:e2e)
   and their ACTUAL outcomes. Mark anything not run.
5. OPEN ISSUES / BLOCKERS: what's unresolved, incl. environment blockers (e.g.
   OneDrive FS storm, no Docker) — be honest about what you could NOT verify.
6. EXACT NEXT STEP: the single concrete next action, with the file(s) and command
   to start from.

Keep it tight and factual. Do not claim anything was verified that wasn't.
```

## Expected deliverables
A concise, factual handoff: done, learned, changed, tested (real results), open,
next step.

## Verification
Modified-files list matches reality; test results are actual; next step is concrete.

## Common failure modes
Overclaiming verification; vague next step; omitting environment blockers; padding.

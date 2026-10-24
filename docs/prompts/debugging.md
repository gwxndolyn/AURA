# Prompt: bug investigation

**When to use** — a defect with observable wrong behavior.

**What to provide** — the bug report, expected behavior, and repro steps/inputs if
known.

## The prompt

```
Use the `aura-debug` skill. Investigate and fix this bug in AURA:

BUG REPORT: [BUG_REPORT]
EXPECTED BEHAVIOR: [EXPECTED_BEHAVIOR]
ACTUAL BEHAVIOR: [ACTUAL_BEHAVIOR]
REPRO (if known): [STEPS_OR_INPUTS]

Steps:
1. Reproduce it first (write the exact repro). If you can't reproduce, say so and
   tell me what you need — don't guess a fix.
2. Collect evidence: server logs ([api error]), /activity + /audit events, the
   failing entity's state, and any failing test output.
3. Trace the failing code path through the layers (route → lib → prisma/model/tool)
   using docs/architecture/repository-map.md.
4. State the ROOT CAUSE, not a symptom.
5. Make the smallest targeted fix.
6. Add a regression test that fails before and passes after (mirror
   isolation.test.ts for a security bug).
7. RUN the failing test + npm run typecheck && npm test. Report results.

Do NOT hide the bug behind a catch-all exception, an arbitrary sleep(), or a
fallback that fakes success.
```

## Expected deliverables
A named root cause, a minimal fix, a regression test, and real test output.

## Verification
The regression test fails on the old code and passes on the new; related tests green.

## Common failure modes
Fixing a symptom; swallowing the error; no repro; no regression test; scope creep.

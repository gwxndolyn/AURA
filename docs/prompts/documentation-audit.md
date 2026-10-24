# Prompt: documentation synchronization

**When to use** — periodically, or after notable changes, to keep docs ↔ code in
sync.

**What to provide** — the area (or "all docs").

## The prompt

```
Use the `aura-documentation` skill. Audit AURA docs against the implementation.

SCOPE: [AREA or "all docs"]

1. For the scope, read the docs AND the real code they describe. Find:
   - claims that no longer match the code (wrong paths, renamed exports, changed
     contracts, removed/added routes, env vars),
   - broken internal links,
   - commands that don't exist in package.json,
   - env vars in docs not in .env.example (and vice versa),
   - capabilities described as implemented that are actually simulated/unverified.
2. Fix the docs to match the CODE (code wins). Mark anything you cannot verify as
   "unverified" rather than guessing.
3. Update the relevant index entries and the maintenance table if a mapping changed.
4. RUN node scripts/check-docs.mjs and report results.

Do not duplicate the same instructions across many docs — link instead.
```

## Expected deliverables
Docs corrected to match code, broken links fixed, unverifiable claims flagged,
validator passing.

## Verification
`node scripts/check-docs.mjs` passes; spot-checked claims trace to real code.

## Common failure modes
"Fixing" code to match docs; inventing to fill gaps; leaving dead links; duplicating
content.

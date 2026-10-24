---
name: aura-documentation
description: Keep AURA documentation accurate against the implementation — find outdated claims, broken links, non-existent commands, and env drift, then fix docs to match the code and run the doc validator. Use after contract changes or for a periodic doc audit.
---

# aura-documentation

## When to use
After changing a contract, or a periodic docs ↔ code sync.

## Required context
`docs/README.md` (index + maintenance table). Validator: `scripts/check-docs.mjs`.

## Workflow
1. For the scope, read the docs AND the real code they describe. Find: claims that
   no longer match (wrong paths/exports/contracts, removed/added routes, env vars),
   broken internal links, commands not in `package.json`, env vars in docs not in
   `.env.example` (and vice versa), capabilities described as implemented that are
   actually simulated/unverified.
2. Fix the docs to match the **code** (code wins). Mark unverifiable claims
   "unverified" rather than guessing.
3. Update index entries + the maintenance table if a mapping changed.
4. Run `node scripts/check-docs.mjs`; fix what it flags.

## Must NOT
"Fix" code to match docs; invent to fill gaps; duplicate instructions across docs
(link instead); leave dead links.

## Validation
`node scripts/check-docs.mjs` passes; spot-checked claims trace to real code.

## Definition of done
Docs match code, links resolve, env in sync, validator green, unverifiable claims
flagged.

## Final report
What was out of date · what you fixed · validator result · remaining unverified
claims.

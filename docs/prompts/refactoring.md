# Prompt: refactoring

**When to use** — improve structure/readability without changing behavior.

**What to provide** — the target and the design problem it has.

## The prompt

```
Use the `aura-refactor` skill. Refactor [TARGET] in AURA.

DESIGN PROBLEM: [THE_ACTUAL_PROBLEM — not "it's ugly"]

1. Identify the real problem and record current behavior (what it does, its callers,
   its public contract). List affected modules.
2. Confirm or add regression tests FIRST so behavior is pinned.
3. Refactor incrementally — small steps, running tests between them.
4. Preserve API contracts and the choke points (complete/callTool/
   requireWorkspaceAccess/api helpers) unless the task explicitly changes them.
5. Compare behavior before/after; confirm tests + typecheck still green and no
   performance regression.

Avoid speculative abstractions and large rewrites without evidence. If the change
balloons, stop and propose a plan instead.
```

## Expected deliverables
Behavior-preserving refactor with regression tests pinned first; contracts intact.

## Verification
Same tests pass before and after; no new behavior; no perf regression.

## Common failure modes
Behavior drift; refactoring without tests first; speculative abstraction; scope blow-up.

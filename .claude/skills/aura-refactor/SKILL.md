---
name: aura-refactor
description: Improve AURA's structure without changing intended behavior — identify the real design problem, pin behavior with regression tests first, refactor incrementally, preserve contracts and choke points, compare before/after. Use for structural cleanup, not features or bug fixes.
---

# aura-refactor

## When to use
Improving maintainability/structure with no intended behavior change.

## Required context
`docs/engineering/code-review.md`, `coding-standards.md`, `architecture/overview.md`.

## Workflow
1. Identify the **actual design problem** (not "it's ugly").
2. Record current behavior (what it does, callers, public contract); list affected
   modules.
3. Confirm or **add regression tests first** so behavior is pinned.
4. Refactor incrementally; run tests between steps.
5. Preserve API contracts and the choke points (`complete`/`callTool`/
   `requireWorkspaceAccess`/`api` helpers) unless the task explicitly changes them.
6. Compare behavior before/after; confirm tests + typecheck green; no perf
   regression.

## Must NOT
Introduce speculative abstractions or large rewrites without evidence. If scope
balloons, stop and propose a plan (`Plan` agent / ADR).

## Validation
Same tests pass before and after; `npm run typecheck && npm test`.

## Definition of done
Behavior-preserving refactor; regression tests pinned first; contracts intact;
checks green.

## Final report
Problem · what changed · regression tests used · before/after confirmation · any
contract notes.

# Prompt: architecture planning

**When to use** — a change with several viable designs; decide before building.

**What to provide** — the goal/problem and any constraints (perf, cost, compat).

## The prompt

```
Examine AURA's current architecture and propose a design for:

GOAL: [GOAL_OR_PROBLEM]
CONSTRAINTS: [CONSTRAINTS]

1. Read docs/architecture/* and the relevant src/lib modules. Describe how the
   relevant part works TODAY (real files, real functions) — no invention.
2. Present 2-3 options. For each: what changes, which choke points it touches,
   trade-offs (complexity, cost, latency, blast radius), and migration/compat.
3. Recommend ONE — the minimal, maintainable change that fits AURA's conventions
   (single model entry point, callTool, requireWorkspaceAccess, in-process bus,
   serverless-safe ticks). Prefer the simplest orchestration that works.
4. Note security + tenant implications and what tests/evals would prove it.
5. If it's significant/hard-to-reverse, draft an ADR for
   docs/architecture/architecture-decisions/.

Do NOT write implementation code yet — produce the plan and wait for approval.
```

## Expected deliverables
A grounded current-state description, option comparison, a single recommendation,
and (if warranted) an ADR draft.

## Verification
Every claim traces to a real file; the recommendation is the smallest change that
meets the goal.

## Common failure modes
Describing an imagined architecture; recommending a big rewrite without evidence;
ignoring tenant/security/cost implications.

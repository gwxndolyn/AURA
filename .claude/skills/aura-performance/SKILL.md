---
name: aura-performance
description: Find and fix a measurable performance bottleneck in AURA — measure a baseline, locate the biggest cause (N+1 queries, redundant model calls, oversized context, rerenders), fix minimally, and re-measure. Use for slowness or cost concerns, measured not guessed.
---

# aura-performance

## When to use
A measurable slowness or AI-cost concern.

## Required context
`docs/ai-engineering/token-and-cost-management.md`, `latency-and-reliability.md`,
`context-engineering.md`, `architecture/*`.

## Workflow
1. **Measure a baseline** — `/api/health` latencies, `AgentRun` latency/cost,
   `/usage`, add timing where needed. Don't guess.
2. Look for: slow routes, **N+1 Prisma queries** (missing `include`/batching),
   repeated/needless model calls, **oversized agent context**, unnecessary React
   rerenders, SSE inefficiencies, missing indexes.
3. Hypothesize the single biggest cause from the data.
4. Fix minimally (index/`include`, batch, shrink context, memoize, lower a tier).
5. **Re-measure** vs baseline; keep only measured wins; report before/after.

## Must NOT
Optimize on intuition; micro-optimize the wrong thing; break tenant scoping for
speed.

## Validation
Before/after numbers; `npm run typecheck && npm test` (behavior unchanged).

## Definition of done
Baseline → identified cause → targeted fix → measured improvement; tests green; no
behavior change.

## Final report
Baseline numbers · the cause · the fix · after numbers (delta) · tests run.

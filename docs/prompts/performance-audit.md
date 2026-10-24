# Prompt: performance audit

**When to use** — a measurable slowness or cost concern.

**What to provide** — the symptom and where it shows (route/page/agent).

## The prompt

```
Use the `aura-performance` skill. Find and fix a performance bottleneck in AURA.

SYMPTOM: [WHAT_IS_SLOW_OR_EXPENSIVE]
WHERE: [ROUTE / PAGE / AGENT / QUERY]

1. MEASURE first — don't guess. Use /api/health latencies, AgentRun latency/cost,
   /usage, and add timing where needed. Capture a baseline.
2. Look for: slow API requests, N+1 Prisma queries (missing include/batching),
   repeated/needless model calls, oversized agent context, unnecessary React
   rerenders, SSE inefficiencies, missing indexes.
3. Hypothesize the ONE biggest cause from the measurements.
4. Fix it minimally (add an index / include, batch queries, shrink context, memoize
   a component, lower a tier).
5. RE-MEASURE and compare to the baseline. Keep the change only if it measurably
   improves; report the before/after numbers.

Do not optimize on intuition. Preserve behavior and tenant scoping.
```

## Expected deliverables
A baseline, an identified cause, a targeted fix, and before/after numbers.

## Verification
Measured improvement; tests still green; no behavior change.

## Common failure modes
Optimizing without measuring; micro-optimizing the wrong thing; breaking scoping to
go faster.

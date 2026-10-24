# Token & cost management

AURA tracks every model call's tokens and cost, and enforces a hard daily budget.

## Tracking

- `complete()` returns `tokensIn`, `tokensOut`, `cost` (via `estimateCost` in
  `pricing.ts`), and `latencyMs`.
- `runAgent` persists these on each `AgentRun` and increments the agent's running
  totals.
- `usageSummary(companyId)` (`budget.ts`) aggregates: total tokens, total cost,
  `todayCost`, per-agent cost, `dailyRemaining`, `overBudget`. Surfaced via
  `/api/companies/[id]/usage` and the settings page.

## Pricing (`pricing.ts`)

Per-million-token prices by model family: opus `{15,75}`, sonnet `{3,15}`, haiku
`{0.8,4}`, fable `{1,5}`; default `{3,15}`. `estimateCost(model, in, out)` computes
cost; `priceFor` matches by family prefix. Add a family entry when you add a model.

## Budgets & guardrails

| Limit | Default | Env | Effect |
|---|---|---|---|
| Daily spend | `25` USD | `AURA_DAILY_BUDGET_USD` | **hard stop** — `checkBudget` throws `BudgetExceededError`, agent pauses |
| Per-task | `2` USD | `AURA_MAX_TASK_USD` | soft budget |
| Agent turns | `6` | `AURA_MAX_AGENT_TURNS` | soft |
| Loop iterations | `25` | `AURA_MAX_ITERATIONS` | `checkLoop` stops the run |
| Tool calls | `60` | `AURA_MAX_TOOL_CALLS` | `checkLoop` stops the run |
| Runtime | `180000` ms | `AURA_MAX_RUNTIME_MS` | `checkLoop` stops the run |

`maybeWarnBudget` emits one-time warnings at 80% and 90%. Budgets are also stored
per company (`Company.dailyBudgetUsd`, `monthlyBudgetUsd`).

## Reducing cost

1. **Route to the lowest adequate tier** ([model-routing](model-routing.md)).
2. **Shrink context** ([context-engineering](context-engineering.md)) — the biggest
   lever; retrieved memory is capped, keep it that way.
3. **Cache safely** — only when it respects user permissions, workspace boundaries,
   data freshness, and privacy. Never cache across tenants or serve a stale
   security-relevant result from cache.
4. **Batch / parallelize** independent calls (`Promise.all`) to cut latency, not
   cost.
5. **Deduplicate** identical in-flight requests where feasible.
6. **Cancel** work that's no longer needed; respect loop/runtime guards.

## The deterministic rule

The budget is enforced in **code** (`checkBudget`), never left to the model. An LLM
cannot authorize itself past the budget — see
[overview](overview.md#where-ai-belongs--and-where-it-doesnt).

# Model & provider abstraction

AURA couples **nothing** to a provider SDK except `src/lib/ai/claude.ts`. That file
is the single seam. Business logic calls `complete()` / `runAgent()` and never sees
Anthropic types.

## The interface

```ts
// src/lib/ai/claude.ts
export interface CompleteParams {
  tier: ModelTier;            // FAST | STANDARD | REASONING
  system: string; prompt: string;
  maxTokens?: number; temperature?: number;
  seed?: string;              // used by the simulator for determinism
  kind?: string;              // output-shape hint
}
export interface CompletionResult {
  text: string; model: string; tier: ModelTier;
  tokensIn: number; tokensOut: number; cost: number; latencyMs: number;
  mode: "live" | "simulation";
}
export async function complete(params: CompleteParams): Promise<CompletionResult>;
export const MODELS: Record<ModelTier, string>;
export function hasApiKey(): boolean;
export function aiMode(): "live" | "simulation";
```

Everything a caller needs — text, usage, cost, latency, and which mode produced it
— is in `CompletionResult`. No provider leakage.

## Model routing (tiers)

Tasks pick a **tier**, not a model string. `MODELS` maps tier → model id (env
overridable):

| Tier | Default model | For |
|---|---|---|
| `FAST` | `claude-haiku-4-5-20251001` | classification, summarization, QA |
| `STANDARD` | `claude-sonnet-5-5` | coding, planning |
| `REASONING` | `claude-opus-5-5` | architecture, security, decisions |

Each `AgentDef` has a default `tier`; `runAgent` can override per call. This keeps
cost/capability routing in one place (see [model-routing](model-routing.md) if
present, else [token-and-cost-management](token-and-cost-management.md)).

## Fallback (reliability)

`complete()` falls back to the deterministic simulator when there's no API key
**or** on any API error, and marks `mode: "simulation"`. The app never crashes on a
provider outage. The fallback is honest — model string is suffixed `(sim)` /
`(fallback)`.

## Adding a provider (if ever needed)

Use the `aura-ai-integration` skill. Keep the same `complete()` contract:

1. Add the provider client construction **inside** `claude.ts` (lazy, like the
   current `getClient()`), selected by config — don't scatter clients.
2. Map the provider's response to `CompletionResult` (text, usage → tokens, cost
   via `pricing.ts`, latency, `mode`).
3. Respect capability differences — **don't pretend** every model supports
   identical tool-calling / structured-output / streaming. Degrade or route around
   gaps explicitly.
4. Add a pricing entry in `pricing.ts` (`priceFor` matches by model-family prefix).
5. Test both the live path (mockable) and that the fallback still triggers.

Do **not** add a provider SDK import anywhere outside `claude.ts`.

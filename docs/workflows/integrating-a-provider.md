# Workflow: integrating a model provider

Skill: `aura-ai-integration`. Detail:
[../ai-engineering/model-provider-abstraction.md](../ai-engineering/model-provider-abstraction.md).

Keep the `complete()` contract; touch **only** `src/lib/ai/`.

1. **Use the existing abstraction.** The new provider plugs into `claude.ts`
   behind the same `complete(params): CompletionResult` surface. No provider SDK
   import anywhere else.
2. **Auth** — read the provider key from env (server-only); construct the client
   lazily (like `getClient()`), selected by config.
3. **Request/response mapping** — map the provider response to `CompletionResult`
   (`text`, `tokensIn/Out`, `cost` via `pricing.ts`, `latencyMs`, `mode`).
4. **Capabilities** — don't assume parity. If the provider lacks tool-calling or
   structured output, degrade/route around it explicitly — don't fake it.
5. **Timeouts, retries, rate limits** — explicit timeout; retry only transient
   errors with backoff; respect provider rate limits.
6. **Usage & cost** — add a `pricing.ts` family entry; ensure tokens/cost are
   tracked per run.
7. **Error classification** — transient vs permanent; fall back to the simulator on
   failure (flagged), like the current path.
8. **Observability** — surface the provider/mode in `/api/ai/status`.
9. **Tests** — mock the live path; assert the fallback still triggers; eval a few
   cases for parity. Don't make CI depend on a paid API.
10. **Docs** — update `model-provider-abstraction.md` and `model-routing.md`.

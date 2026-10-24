# Prompt: AI provider integration

**When to use** — add a model provider behind AURA's existing abstraction.

**What to provide** — the provider + models and which tier(s) they serve.

## The prompt

```
Use the `aura-ai-integration` skill. Add [PROVIDER_NAME] to AURA.

MODELS / TIERS: [MODEL_IDS_AND_TIERS]

Keep the complete() contract and touch ONLY src/lib/ai/:
1. Read src/lib/ai/claude.ts, pricing.ts, simulator.ts. Plug the provider in behind
   complete() — no provider SDK import anywhere else in the app.
2. Construct the client lazily (like getClient()), selected by config; read the key
   from env (server-only).
3. Map the provider response to CompletionResult (text, tokensIn/Out, cost via
   pricing.ts, latencyMs, mode). Add a pricing family entry.
4. Handle capability gaps explicitly (tool-calling/structured output/streaming) —
   do NOT pretend parity. Add timeout, transient-only retry with backoff, rate-limit
   handling.
5. Keep the simulator fallback working (missing key / API error → flagged
   mode:"simulation").
6. Surface provider/mode in /api/ai/status.
7. Tests: mock the live path; assert the fallback still triggers; a few parity
   evals. Don't make CI depend on a paid API.

RUN npm run typecheck && npm test. Update model-provider-abstraction.md +
model-routing.md.
```

## Expected deliverables
Provider wired inside `claude.ts` only; pricing + status updated; tests green;
fallback intact.

## Verification
`/api/ai/status` reflects the provider; tests pass with the live path mocked; forced
error falls back and is flagged.

## Common failure modes
Leaking the SDK into business logic; assuming capability parity; blind retries;
breaking the fallback; CI depending on a real key.

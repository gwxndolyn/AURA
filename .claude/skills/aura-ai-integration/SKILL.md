---
name: aura-ai-integration
description: Integrate a new AI capability or model provider in AURA behind the existing complete() abstraction — auth, response mapping, pricing, capability gaps, timeouts/retries, usage tracking, fallback, tests. Use when adding a provider or AI capability.
---

# aura-ai-integration

## When to use
Adding a model provider or a new AI capability. Keep business logic off the
provider SDK.

## Required context
`docs/ai-engineering/model-provider-abstraction.md`, `model-routing.md`,
`docs/workflows/integrating-a-provider.md`. Code: `src/lib/ai/*`.

## Workflow
1. Read `claude.ts`, `pricing.ts`, `simulator.ts`. Plug the provider in **behind
   `complete()`** — no provider SDK import outside `claude.ts`.
2. Construct the client lazily (like `getClient()`), selected by config; key from
   env (server-only).
3. Map the response → `CompletionResult` (text, tokensIn/Out, `cost` via
   `pricing.ts`, latencyMs, `mode`). Add a `pricing.ts` family entry.
4. Handle capability gaps explicitly (tool-calling / structured output / streaming)
   — do not assume parity.
5. Timeout + transient-only retry with backoff + rate-limit handling. Keep the
   simulator fallback working (missing key / error → flagged `mode:"simulation"`).
6. Surface provider/mode in `/api/ai/status`.
7. Tests: mock the live path; assert fallback triggers; a few parity evals. CI must
   not depend on a paid key.

## Security
Key server-only; never logged; never passed to the sandbox.

## Validation
`npm run typecheck && npm test`. Confirm `/api/ai/status` reflects the provider and
a forced error falls back (flagged).

## Definition of done
Provider wired inside `claude.ts` only; pricing + status updated; tests green;
fallback intact; docs updated.

## Final report
What was integrated · where (confirm only `src/lib/ai/` touched) · capability gaps
handled · tests + results.

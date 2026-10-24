# Production AI checklist

Before shipping an AI feature in AURA, verify every line. Cross-refs in each item.

## Provider & routing
- [ ] All model calls go through `complete()`/`runAgent` — no SDK import outside
      `claude.ts`. ([model-provider-abstraction](model-provider-abstraction.md))
- [ ] Correct tier for the task; no "everything on the big model".
      ([model-routing](model-routing.md))
- [ ] Fallback path works and is flagged (`mode`). ([latency-and-reliability](latency-and-reliability.md))

## Prompt & context
- [ ] Stable instructions in system prompt; task data in context sections.
- [ ] Untrusted content (user/retrieved/tool) is labeled and separate; can't widen
      authority. ([prompt-injection-defense](prompt-injection-defense.md))
- [ ] Context is minimal + retrieved, not dumped. ([context-engineering](context-engineering.md))

## Output & tools
- [ ] Output validated before use (Zod/`parseJSON` with safe fallback).
      ([structured-outputs](structured-outputs.md))
- [ ] Tools go through `callTool`; least-privilege allowlist; args validated;
      timeout + idempotency; audited. ([tool-calling](tool-calling.md))

## Safety & authority (deterministic, not prompt)
- [ ] Permissions enforced server-side; a prompt can't grant a tool.
- [ ] Tenant isolation: every query scoped by `companyId`.
- [ ] Security-critical values computed in code, not asked of the model.
- [ ] Consequential actions gated by backend approval. ([human-approval](human-approval.md))

## Cost, latency, reliability
- [ ] Tokens/cost tracked per run; daily budget hard-stop respected.
      ([token-and-cost-management](token-and-cost-management.md))
- [ ] Loops bounded (`checkLoop`); retries only transient/idempotent with backoff.
- [ ] Timeouts on every external/tool call.

## Observability
- [ ] State changes emit events; security actions audited.
- [ ] Failures surface (attention panel / `AGENT_FAILED`), not swallowed.
- [ ] `/api/health` + `/api/ai/status` reflect the subsystem honestly.

## Evaluation
- [ ] Fixed eval set with regressions; asserts shape/invariants, not prose.
- [ ] Security eval (injection → refused). ([evaluation-and-testing](evaluation-and-testing.md))
- [ ] Cost/latency tracked per case; threshold set.
- [ ] Tests actually ran and passed.

## Docs
- [ ] Prompt/tool/permission/env changes documented
      ([../README.md#maintenance](../README.md#maintenance)).

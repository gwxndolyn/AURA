# Code review

Use the `aura-code-review` skill (or the built-in `/code-review`) for a structured
pass. This page is the standard reviewers hold changes to.

## Review order (most important first)

1. **Correctness** — does it do what the task says? Edge cases, off-by-ones,
   null/empty, error paths.
2. **Security & tenancy** — every company query scoped by `companyId`? Nested ids
   via `findFirst({ id, companyId })`? `requireWorkspaceAccess` with the right role?
   No secret in client code? Input validated with Zod? Untrusted AI/retrieved
   content treated as untrusted?
3. **Architecture** — logic in `src/lib`, routes thin? Choke points used (model,
   tool, auth, api, events)? No duplicate of existing functionality?
4. **Data integrity** — migrations additive/safe? JSON columns parsed with
   fallbacks? No `db:reset`-as-fix?
5. **Error handling** — typed errors, no swallowed catches, fallbacks flagged not
   disguised?
6. **Concurrency** — no floating promises; independent awaits parallelized; no
   `sleep()` papering over ordering.
7. **Performance** — no N+1 (use `include`/batched queries); no needless repeated
   model calls; no oversized context sent to agents.
8. **Tests** — appropriate type, actually runnable, security test for new
   routes/tools, and the author ran them.
9. **Maintainability** — reads like surrounding code; no speculative abstraction.
10. **Docs** — contract changes reflected (see
    [../README.md#maintenance](../README.md#maintenance)).

## Severity

Rank findings **Critical / High / Medium / Low** and cite exact `file:line`. A
review that invents problems to look thorough is worse than a short, true one. If
it's clean, say so.

## AI-specific checks

- Model output validated before use (not trusted because it's JSON).
- No prompt can grant itself permissions; tool authorization is server-side.
- Token/cost impact considered; budget guard respected.
- Agent given least privilege (no widened allowlist for convenience).

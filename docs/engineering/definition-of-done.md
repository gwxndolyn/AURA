# Definition of done

A change is done when **all** of these are true — not when the code compiles.

## Checklist

- [ ] **Implemented** the smallest complete vertical slice (no frontend-only stub
      when backend work is required, and vice versa).
- [ ] **Reused** the choke points (model/tool/auth/api/events); no duplicated
      functionality; no new dependency without justification.
- [ ] **Security**: queries scoped by `companyId`; nested ids via
      `findFirst({ id, companyId })`; correct `requireWorkspaceAccess` role; input
      validated with Zod; AI/untrusted content validated; no secret in client code;
      agent permissions not widened.
- [ ] **Error handling**: typed `ApiError`/`AuthError`; no swallowed errors;
      fallbacks flagged (`mode`/`real`), not disguised.
- [ ] **Logging/events**: state changes emit events; security actions audited.
- [ ] **Tests** added/updated for the behavior and the risk (incl. a
      cross-workspace denial test for new company routes, a permission test for new
      tools) — **and you ran them**.
- [ ] **Validation run and green**: `npm run typecheck`, `npm run lint`,
      `npm test` (and `npm run test:e2e` if a journey changed).
- [ ] **Docs updated** for any changed contract (API/schema/env/tools/prompts) per
      [../README.md#maintenance](../README.md#maintenance); `node scripts/check-docs.mjs`
      passes if docs changed.
- [ ] **Verification note**: you reported exactly what you ran and what passed —
      no claims you didn't verify. Breaking changes documented.

## Honesty rules

- If tests fail, say so and show the output. If a step was skipped, say that.
- If something is blocked (e.g. OneDrive FS storm, no Docker), state the limitation
  rather than faking a result or hiding it behind a fallback.
- "Done" means verified. "Should work" is not done.

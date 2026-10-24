# Secure development

Baseline practices for every change. Use the `aura-security-audit` skill for a
focused pass; [threat-model](threat-model.md) for the full picture.

## Always

1. **Authorize** every company route with `requireWorkspaceAccess(id, role)` before
   touching data. ([tenant-isolation](tenant-isolation.md))
2. **Scope** every query by `companyId`; nested ids via `findFirst({ id, companyId })`.
3. **Validate** all input with Zod (`parseBody`); validate AI output before use.
4. **Least privilege** for agent tools; never widen an allowlist for convenience.
   ([agent-permissions](agent-permissions.md))
5. **Keep secrets server-side**; never `NEXT_PUBLIC_` a secret; never log one.
   ([secret-management](secret-management.md))
6. **Run untrusted code only in the sandbox**, never relax its flags.
   ([sandbox-security](sandbox-security.md))
7. **Enforce authority in code**, never in prompt wording.
   ([../ai-engineering/prompt-injection-defense](../ai-engineering/prompt-injection-defense.md))
8. **Audit** security-relevant actions (`audit`, automatic for tool calls).

## Common pitfalls (and the AURA-correct form)

| Pitfall | Correct |
|---|---|
| `findUnique({ id })` on a nested resource | `findFirst({ id, companyId })` |
| 403 that reveals a workspace exists | 404 via `requireWorkspaceAccess` |
| Trusting a frontend role check | re-check on the backend |
| `JSON.parse(model.text) as T` | `parseJSON<T>(text, fallback)` / Zod |
| Running a tool because the model asked | `callTool` checks the allowlist |
| Catching an error into a fake success | typed error, flagged fallback |
| Secret in a client component / `NEXT_PUBLIC_` | server-only read |
| Raw SQL / string-built queries | Prisma |
| `--network bridge` to make a template work | redesign the template |

## Verifying

- `grep` for new `findUnique(` on company resources — each needs a `companyId`.
- Add a cross-workspace denial test for new routes; a permission test for new tools.
- `npm audit` for dependency CVEs; keep Next ≥ 15.5.4.
- For the cyber range: operate only against the isolated simulation. Never launch
  anything at a real external system. Verify findings with safe tests.

## Dual-use note

Security tooling in AURA (the cyber range) is for the authorized, isolated
simulation only. Do not repurpose it against real systems.

# Developer checklists

Short, specific, everyday checklists. Each item names a concrete control/test, not
"be secure". Pair with the matching skill.

## New feature
- [ ] Acceptance criteria written.
- [ ] Vertical slice (no FE-only when BE needed).
- [ ] Reused choke points (model/tool/auth/api/events).
- [ ] Tenant scope + `requireWorkspaceAccess` role correct.
- [ ] Tests incl. cross-workspace 404; ran them.
- [ ] Docs for changed contracts.

## New API endpoint
- [ ] `handler()` + `dynamic="force-dynamic"`; `await ctx.params`.
- [ ] `requireWorkspaceAccess(id, VIEWER|MEMBER|OWNER)` first.
- [ ] Zod `parseBody`; enums from `@/lib/types`.
- [ ] Queries scoped by `companyId`; nested via `findFirst({id,companyId})`.
- [ ] `ok`/`err`; throw `ApiError`/`AuthError` (no try/catch).
- [ ] `emitEvent`/`audit`; `maxDuration` if AI/sandbox.
- [ ] IDOR test; inventory updated.

## New database model/field
- [ ] Additive, data-preserving; `@@index` for new queries; `@@unique` for keys.
- [ ] Enum values mirrored in `types.ts` + schema comment.
- [ ] `db:push` (not `db:reset`); `db:generate` if needed.
- [ ] `parseJSON` fallbacks still valid; seed updated.
- [ ] Test reads/writes the field; `database.md` updated.

## New AI agent
- [ ] One responsibility; `AgentDef` with constrained system prompt.
- [ ] Minimal `ROLE_PERMISSIONS` allowlist.
- [ ] Lowest adequate tier; budget/loop guards apply.
- [ ] Output validated; memory = safe summaries.
- [ ] Eval cases (shape, tool-selection, injection-refusal).
- [ ] `definitions.test.ts` + `permissions.test.ts` assertions.

## New tool
- [ ] In `ALL_TOOLS`, `area.verb`.
- [ ] Granted to minimum roles only.
- [ ] Called via `callTool`; args validated in impl; timeout/idempotent.
- [ ] Permission test for denied roles; audited (automatic).
- [ ] `agent-permissions.md` table updated.

## New model provider
- [ ] Only `src/lib/ai/` touched; `complete()` contract kept.
- [ ] Response → `CompletionResult`; pricing family added.
- [ ] Capability gaps handled explicitly; timeouts/retries/rate limits.
- [ ] Fallback still triggers; live path mocked in tests.

## New background job
- [ ] Right pattern (in-request / fire-and-forget / durable).
- [ ] Bounded (`checkBudget`/`checkLoop`), timeouts, idempotent.
- [ ] Failures emit events; durable work persists state.

## New UI page
- [ ] `"use client"`; `useQuery`/`useMutation` (not raw fetch).
- [ ] Loading (`Skeleton`) + empty (`EmptyState`) states.
- [ ] Nav + command-palette entry; semantic Tailwind tokens.
- [ ] No authz logic in the client.

## New security control
- [ ] Addresses a named threat; enforced in code; fail-closed.
- [ ] Audited; violation surfaced.
- [ ] Test proves it blocks the bad case; threat model updated.

## New integration
- [ ] Timeout + error classification + bounded retry (transient only).
- [ ] Secrets server-only; no `NEXT_PUBLIC_`.
- [ ] Flagged fallback on failure; usage/cost tracked if AI.

## Refactor
- [ ] Real design problem identified; behavior recorded first.
- [ ] Regression tests before changing; API contracts preserved.
- [ ] Incremental; before/after behavior + tests compared.

## Release
- [ ] typecheck + lint + test (+ e2e for journeys) green; build OK.
- [ ] Migrations + rollback; security-sensitive changes reviewed.
- [ ] Env/config documented; observability updated; release notes.
- [ ] `check-docs.mjs` passes. Block if a critical check fails.

## Production incident
- [ ] Scope + impact from `/api/health`; evidence preserved.
- [ ] Reversible mitigation first; approval before destructive actions.
- [ ] Root cause + regression test; recovery verified; documented.

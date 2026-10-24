# Production readiness audit (2026-10-20)

Verdict: **not ready for a public production launch.** The core
product-building workflow works end to end on codebases with a known test
harness, with real tests, real git and enforced approvals. The blockers below
are real and listed honestly. Capability ledger:
[implementation-status.md](implementation-status.md); gap analysis:
[autonomous-product-factory-audit.md](autonomous-product-factory-audit.md).

## Blockers before a public launch

| # | Area | Finding | Required action |
|---|---|---|---|
| 1 | Dependencies | `npm audit --omit=dev` reported **critical** advisories for `next@15.5.4`. Upgraded to `next@15.5.28` + `npm audit fix` (critical and `sharp` resolved). **Remaining: high `postcss` advisory bundled inside Next 15** — npm only offers Next 16 (major) as the fix | Plan the Next 16 upgrade; CSS is build-time and not attacker-supplied here, which limits exposure |
| 2 | Execution scope | Executable tasks only on codebases with a known test harness; arbitrary repos can't be executed (sandbox has no network for installs) | Allow-listed package proxy + per-project test command execution |
| 3 | Deployment | No product deployment provider; deploy requests are `NOT_DEPLOYED` | Implement a provider adapter with confirmed status + health checks |
| 4 | Live AI | Model paths (PM, designer, architect, engineer) untested with a real key | Run the evaluation suites with a key; add PM/design datasets |
| 5 | Source control live | GitHub/GitLab push + PR verified only against a local remote and a mocked API | Verify with a repo-scoped token; consider a GitHub App |
| 6 | Workers | No background worker; long runs progress only while ticks are requested | Optional worker process using the same leases |
| 7 | Rate limits | In-memory per-process (auth, product creation counts in DB) | Shared store (Redis) for multi-instance |
| 8 | Data | SQLite default; `AURA_GIT_ROOT` defaults to the OS temp dir | Postgres + durable volume for git; backup both together |

## Security controls (implemented and tested)

| Control | Where | Tested by |
|---|---|---|
| Session auth (HMAC, httpOnly, SameSite=Lax, Secure in prod; `AUTH_SECRET` required in prod) | `auth/session.ts` | auth tests |
| Server-side workspace isolation + RBAC per action class | `requireWorkspaceAccess`, approvals route | every `*.api.test.ts`; `factory.api.test.ts` (404 cross-workspace, 403 role) |
| IDOR-safe nested ids | `findFirst({ id, companyId })` throughout `factory/` | factory tests (other workspace → not found) |
| Agent tool allowlists + write scope enforced in code | `agents/permissions.ts`, `tools.ts` | permissions tests, mission tests |
| Untrusted code isolation (Docker `--network none`, limits, timeouts) | `sandbox/*` | sandbox + devspace tests |
| Path traversal / protected files | `devspace/paths.ts`, reused by git writes (`.git` refused) | devspace + factory git tests |
| Secrets never stored for git providers; token in env header, redacted errors | `factory/git.ts`, repo route (rejects token-like values) | factory API test |
| Webhook authenticity (HMAC / token, constant-time) + idempotency | `factory/webhooks.ts` | factory tests |
| Evidence-only verification; approvals with payload hashes | `factory/lifecycle.ts`, `release.ts`, missions | factory tests |
| Budget hard-stop + loop guards on every model call | `ai/budget.ts`, `agents/guardrails.ts` | budget/guardrail tests |
| Audit log for consequential actions | `audit()` | — |

## Reliability

Bounded retries (transient categories only) · bounded repairs · dispatch
limits · product + mission leases with crash takeover · idempotent ticks,
commits (idempotency key), PRs (existing PR reused) and webhook deliveries ·
cancellation propagates and reports what could not stop · errors are typed and
never reported as success.

## Actions taken in this pass

- Product lifecycle, git, release and webhook subsystems with tests (see ledger).
- Documented `AUTH_SECRET` (previously missing from `.env.example`) and
  `AURA_GIT_ROOT`.
- Upgraded `next` 15.5.4 → 15.5.28 and applied `npm audit fix`; re-ran typecheck, lint, Vitest (304/304) and the full Playwright suite (16/16) afterwards.

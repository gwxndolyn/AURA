# Environment variables (reference)

Canonical list. Setup guidance:
[../getting-started/environment-setup.md](../getting-started/environment-setup.md).
The doc validator checks that everything in `.env.example` appears here.

## In `.env.example`

| Variable | Purpose | Default | Scope |
|---|---|---|---|
| `DATABASE_URL` | Prisma connection string | `file:./dev.db` | server |
| `REDIS_URL` | Optional multi-process event bus / queues | *(blank → in-memory)* | server |
| `ANTHROPIC_API_KEY` | Enables real Claude agents (else simulation) | *(blank)* | **server-only** |
| `CLAUDE_MODEL_FAST` | FAST-tier model id | `claude-haiku-4-5-20251001` | server |
| `CLAUDE_MODEL_STANDARD` | STANDARD-tier model id | `claude-sonnet-5-5` | server |
| `CLAUDE_MODEL_REASONING` | REASONING-tier model id | `claude-opus-5-5` | server |
| `NEXT_PUBLIC_APP_URL` | App base URL | `http://localhost:3000` | **public** |
| `AUTH_SECRET` | HMAC secret for session tokens (≥16 chars); **required in production** | *(blank → insecure dev default)* | **server-only** |
| `AURA_DIST_DIR` | Relocate Next build output off synced folders | *(unset → `.next`)* | build |
| `AURA_SANDBOX_IMAGE` | Sandbox container image | `node:20-alpine` | server |
| `AURA_SANDBOX_MEMORY` | Sandbox memory cap | `256m` | server |
| `AURA_SANDBOX_CPUS` | Sandbox CPU cap | `1` | server |
| `AURA_SANDBOX_TIMEOUT_MS` | Sandbox exec timeout (ms) | `20000` | server |
| `ANTHROPIC_BASE_URL` | Optional gateway/proxy for the Anthropic API (also used by automated tests to point at a test double) | *(blank → api.anthropic.com)* | server |
| `AURA_MODEL_TIMEOUT_MS` | Per-request model timeout | `120000` | server |
| `AURA_AGENT_MAX_TURNS` | Max tool-use turns per agent step in a run | `40` | server |
| `AURA_WORKER` | `inline` (worker in the web process) · `external` (`npm run worker`) · `off` | `inline` | server |
| `AURA_WORKER_CONCURRENCY` | Jobs processed concurrently per worker process | `2` | server |
| `AURA_JOB_LEASE_MS` | Job lease (crashed-worker takeover after this) | `120000` | server |
| `AURA_JOB_BACKOFF_MS` | Base retry backoff (exponential) | `5000` | server |
| `AURA_WORK_ROOT` | Directory for run working trees | *(blank → `<tmpdir>/aura-work`)* | server |
| `AURA_INSTALL_TIMEOUT_MS` | Dependency install timeout | `240000` | server |
| `AURA_COMMAND_TIMEOUT_MS` | Test/lint/build command timeout | `120000` | server |
| `AURA_SANDBOX_INSTALL_MEMORY` | Memory cap for the install step | `1g` | server |
| `STRIPE_SECRET_KEY` | Stripe API key (`sk_test_…` for test mode) | *(blank → billing not configured)* | **server-only** |
| `STRIPE_WEBHOOK_SECRET` | Verifies `/api/billing/webhook` signatures | *(blank)* | **server-only** |
| `STRIPE_PRICE_PRO` / `STRIPE_PRICE_TEAM` | Stripe price ids for the plans in `src/lib/billing/plans.ts` | *(blank)* | server |
| `GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_APP_PRIVATE_KEY` | GitHub App credentials (private key PEM, `\n` escapes allowed) | *(blank → GitHub not configured)* | **server-only** |
| `RESEND_API_KEY` / `EMAIL_FROM` | Transactional email (password reset, billing notices) | *(blank → emails stay PENDING)* | **server-only** |
| `NEXT_PUBLIC_COMPANY_NAME` / `NEXT_PUBLIC_SUPPORT_EMAIL` / `NEXT_PUBLIC_SECURITY_EMAIL` | Operator details shown on legal/support pages | *(blank)* | **public** |
| `AURA_SIMULATION_LAB` / `NEXT_PUBLIC_AURA_SIMULATION_LAB` | Enable the legacy company-simulator surfaces (`1`) | *(off)* | server / public |
| `AURA_REGISTER_LIMIT_PER_HOUR` | Account registrations allowed per IP per hour | `5` | server |
| `AURA_GIT_ROOT` | Directory for product git repositories (bare repos) | *(blank → `<tmpdir>/aura-git`)* | server |

## Read by code, not in `.env.example` (defaults fine locally)

| Variable | Purpose | Default | Where |
|---|---|---|---|
| `AURA_DAILY_BUDGET_USD` | Daily AI budget hard-stop | `25` | `ai/budget.ts` |
| `AURA_MAX_TASK_USD` | Soft per-task budget | `2` | `ai/budget.ts` |
| `AURA_MAX_AGENT_TURNS` | Soft agent-turn cap | `6` | `ai/budget.ts` |
| `AURA_MAX_ITERATIONS` | Loop-guard iterations | `25` | `agents/guardrails.ts` |
| `AURA_MAX_TOOL_CALLS` | Loop-guard tool calls | `60` | `agents/guardrails.ts` |
| `AURA_MAX_RUNTIME_MS` | Loop-guard runtime | `180000` | `agents/guardrails.ts` |
| `AURA_EVAL_MAX_MODEL_CALLS` | Model-call cap per evaluation | `40` | `intelligence/evaluation.ts` |
| `AURA_EVAL_MAX_COST_USD` | Spend cap per evaluation | `1` | `intelligence/evaluation.ts` |
| `AURA_EVAL_TIMEOUT_MS` | Wall-clock cap per evaluation | `120000` | `intelligence/evaluation.ts` |
| `PORT` | Dev/prod port | `3000` | Next.js |

## Commercial and agent quality (V8–V10)

| Variable | Purpose | Where |
|---|---|---|
| `AURA_SECRETS_KEY` | 32-byte key (base64 or hex) encrypting tenant secrets with AES-256-GCM. Without it customers cannot store deployment secrets. | `security/secrets.ts` |
| `STRIPE_PRICE_PRO_YEARLY` / `STRIPE_PRICE_TEAM_YEARLY` | Annual Stripe price ids (optional; plans without one are monthly only) | `billing/plans.ts` |
| `AURA_PLANS_FILE` | Alternative plan catalogue (shape of `config/plans.json`); validated at load | `billing/plans.ts` |
| `AURA_TRUST_PROXY` | `1` = use the first `X-Forwarded-For` hop for rate limits (only behind your own proxy) | `auth/rateLimit.ts` |
| `AURA_ALLOWED_ORIGINS` | Extra origins allowed to send state-changing `/api` requests (CSRF check) | `auth/csrf.ts` |
| `AURA_DEPLOY_ENV_ALLOWLIST` | Single-tenant self-hosting: server env names deployments may read (default none — tenant secrets only) | `deploy/service.ts` |
| `AURA_BROWSER_VERIFY` | `0` disables browser verification (reported as not run) | `builder/browser.ts` |
| `AURA_EVIDENCE_ROOT` | Directory for browser screenshots (default OS temp) | `builder/browser.ts` |
| `AURA_ALLOW_SIMULATED_PROMOTION` | Automated tests only: lets a prompt be promoted on simulated-provider evidence (never set in production) | `intelligence/experiments.ts` |
| `AURA_FAULT_INJECTION` | `1` enables failure injection **only** when `NODE_ENV=test` (resilience tests); ignored everywhere else | `resilience/inject.ts` |
| `AURA_MAINTENANCE_INTERVAL_MS` | Worker maintenance tick (retention, quota-hold recovery, token purge); default 15 min | `jobs/worker.ts` |

## Named by configuration (you choose the names)

| Variable | Purpose | Where |
|---|---|---|
| *token env var* (e.g. `AURA_GITHUB_TOKEN`) | Repo-scoped GitHub/GitLab token used to push `aura/*` branches and open PR/MRs. Only its **name** is stored on the repository connection. | `factory/git.ts` |
| *webhook secret env var* (e.g. `AURA_GITHUB_WEBHOOK_SECRET`) | Verifies `/api/webhooks/{github,gitlab}` deliveries | `factory/webhooks.ts` |

## Rules

- Only `NEXT_PUBLIC_*` reaches the browser. **Never** prefix a secret with it.
- Adding a variable? Update **three** places: `.env.example`, this table, and
  [environment-setup](../getting-started/environment-setup.md). The validator fails
  if `.env.example` and this doc disagree.
- `Company.dailyBudgetUsd` / `monthlyBudgetUsd` are **per-company** budgets stored
  in the DB, distinct from the global `AURA_DAILY_BUDGET_USD`.

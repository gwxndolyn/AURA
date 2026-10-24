# Environment setup

All configuration is via environment variables. Copy `.env.example` → `.env`.
**Nothing is required to run.** Full reference:
[../operations/environment-variables.md](../operations/environment-variables.md).

## The variables

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Prisma connection string | `file:./dev.db` (SQLite) |
| `REDIS_URL` | Optional multi-process bus/queue | *(blank → in-memory)* |
| `ANTHROPIC_API_KEY` | Enables real Claude agents (server-only) | *(blank → simulation)* |
| `CLAUDE_MODEL_FAST` | FAST tier model (classify/summarize/QA) | `claude-haiku-4-5-20251001` |
| `CLAUDE_MODEL_STANDARD` | STANDARD tier (code/plan) | `claude-sonnet-5-5` |
| `CLAUDE_MODEL_REASONING` | REASONING tier (architecture/security/decisions) | `claude-opus-5-5` |
| `NEXT_PUBLIC_APP_URL` | App base URL (the one `NEXT_PUBLIC_` var) | `http://localhost:3000` |
| `AURA_DIST_DIR` | Relocate Next build output off synced folders | *(unset → `.next`)* |
| `AURA_SANDBOX_IMAGE` | Sandbox container image | `node:20-alpine` |
| `AURA_SANDBOX_MEMORY` | Sandbox memory cap | `256m` |
| `AURA_SANDBOX_CPUS` | Sandbox CPU cap | `1` |
| `AURA_SANDBOX_TIMEOUT_MS` | Sandbox exec timeout | `20000` |

Also read by code but not in `.env.example` (defaults are fine locally):
`AURA_DAILY_BUDGET_USD` (25), `AURA_MAX_TASK_USD` (2), `AURA_MAX_AGENT_TURNS` (6),
`AURA_MAX_ITERATIONS` (25), `AURA_MAX_TOOL_CALLS` (60), `AURA_MAX_RUNTIME_MS`
(180000). See [../ai-engineering/token-and-cost-management.md](../ai-engineering/token-and-cost-management.md).

## Rules

- `ANTHROPIC_API_KEY` is **server-only** — only `NEXT_PUBLIC_`-prefixed vars reach
  the browser. Never prefix a secret with `NEXT_PUBLIC_`. Never commit `.env`.
- Changing a model var changes which Claude model each tier uses; keep the three
  tiers pointed at genuinely FAST/STANDARD/REASONING-class models.
- If you add a variable, add it to `.env.example`, the table above, and
  [../operations/environment-variables.md](../operations/environment-variables.md)
  (the doc validator checks `.env.example` ↔ docs).

## Optional: Postgres + Redis

```bash
docker compose up -d        # postgres:16-alpine + redis:7-alpine
# then in .env:
#   DATABASE_URL="postgresql://aura:aura@localhost:5432/aura?schema=public"
#   REDIS_URL="redis://localhost:6379"
# and set the datasource provider in prisma/schema.prisma to "postgresql"
npm run db:push && npm run db:seed
```

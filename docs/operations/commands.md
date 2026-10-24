# Command reference

Verified against `package.json`, `playwright.config.ts`, `docker-compose.yml`, and
`next.config.mjs`. **Unavailable** = not implemented (don't invent it).

> On this machine (OneDrive-synced), always prefix dev/build/e2e with
> `AURA_DIST_DIR=/tmp/aura-next`. See
> [../getting-started/troubleshooting.md](../getting-started/troubleshooting.md).

## npm scripts (all real)

| Command | Runs | Notes |
|---|---|---|
| `npm run dev` | `next dev` | **Use `AURA_DIST_DIR=/tmp/aura-next npm run dev` here.** |
| `npm run build` | `prisma generate && next build` | Prefix `AURA_DIST_DIR=` on synced folders. |
| `npm start` | `next start` | Serve a production build. |
| `npm run typecheck` | `tsc --noEmit` | Must be exit 0 (build fails on type errors). |
| `npm run lint` | `next lint` | ESLint (`next/core-web-vitals`). |
| `npm test` | `vitest run` | Unit tests (`src/**/*.test.ts`). |
| `npm run test:watch` | `vitest` | Watch mode. |
| `npm run test:e2e` | `playwright test` | Starts its own dev server (`AURA_DIST_DIR=/tmp/aura-next-e2e`). |
| `npm run test:e2e:install` | `playwright install chromium` | One-time; needs sandbox disabled on this box. |
| `npm run db:push` | `prisma db push` | Sync schema → SQLite (additive-safe). |
| `npm run db:seed` | `tsx prisma/seed.ts` | Seed NOVA PAY demo (idempotent). Needs sandbox disabled on this box (tsx IPC). |
| `npm run db:reset` | `prisma db push --force-reset && tsx prisma/seed.ts` | **Destructive** — drops all data. |
| `npm run db:generate` | `prisma generate` | Regenerate Prisma client. |
| `npm run setup` | `db:push && seed` | First-run convenience. |
| `npm run audit:skills` | `tsx scripts/audit-skills.ts` | Read-only skill/prompt-library audit; exit 1 if a skill needs manual review. Needs sandbox disabled on this box (tsx IPC). |

## Documentation validation

| Command | Does |
|---|---|
| `node scripts/check-docs.mjs` | Verify required docs exist, internal links resolve, skills are well-formed, `.env.example` ↔ docs match. See [quality-gates](../workflows/quality-gates.md). |

## Optional infra (docker-compose)

| Command | Does |
|---|---|
| `docker compose up -d` | Start `postgres:16-alpine` + `redis:7-alpine`. |
| `docker compose down` | Stop them (add `-v` to drop volumes). |

After starting Postgres: set `DATABASE_URL`, switch the datasource provider in
`prisma/schema.prisma` to `postgresql`, then `npm run db:push && npm run db:seed`.

## Health & status (running app)

```bash
curl -s localhost:3000/api/health     # subsystem probe (DB, claude, sandbox, redis, stream)
curl -s localhost:3000/api/ai/status  # { mode, models, budget, sandbox }
```

## Not available (do not invent)

- No `format` / Prettier script (ESLint only).
- No standalone `migrate` script (SQLite uses `db push`; no committed migration
  history).
- No `start:prod` / Docker image build for the app itself.
- No coverage script.

If you need one of these, add it to `package.json` deliberately and document it
here — don't fabricate it in docs.

# Deployment

Two distinct meanings of "deploy" in AURA — don't confuse them:

1. **The simulated deploy pipeline** *inside* the product (`workflows/deploy.ts`) —
   a deterministic build→test→scan→deploy→health-check that updates `Deployment`
   state. **Nothing ships to a real host.** This is a feature of the simulation.
2. **Deploying the AURA app itself** — running this Next.js app in production.

This page covers (2). For (1) see
[../architecture/overview.md](../architecture/overview.md) and the `aura-release`
skill.

## Deploying the app (reference)

AURA is a standard Next.js 15 app. There is **no app Dockerfile or deploy script in
the repo** today (marked here honestly). To deploy:

```bash
npm ci
npm run build        # prisma generate && next build  (set AURA_DIST_DIR off synced storage if applicable)
npm start            # next start   (PORT configurable)
```

### Requirements

- Node 20+.
- A database. SQLite works for a single instance; for anything shared/multi-instance
  use **Postgres** (switch the datasource provider to `postgresql`, set
  `DATABASE_URL`, run `prisma db push` — adopt `prisma migrate` for real migration
  history).
- Env via the platform's secret store (never a committed `.env`):
  `DATABASE_URL`, `ANTHROPIC_API_KEY` (optional — simulation mode without),
  `NEXT_PUBLIC_APP_URL`, model + sandbox vars as needed. See
  [environment-variables](environment-variables.md).

### Caveats to decide before production

- **Event bus is in-process** (single instance). Multiple instances need a
  Redis-backed bus for SSE to work across them.
- **No background worker.** Fire-and-forget work (the demo route) and long agent
  runs assume the process stays alive; a scale-to-zero platform will drop them.
- **Docker sandbox** needs a Docker daemon on the host, or coding tasks fall back to
  flagged simulated results. Many PaaS hosts don't offer Docker-in-the-box.
- **Auth** exists and is tested; ensure the session signing secret is set and
  stable across instances.

## Release gate

Before recommending a release, run the `aura-release` skill / the
[release-readiness prompt](../prompts/release-readiness.md): acceptance criteria,
migrations, tests, build, security-sensitive changes, config/env, observability,
rollback, release notes. **Block the release if a critical check fails.**

## Rollback

- App: redeploy the previous build/image.
- Data: SQLite — restore the `dev.db`/volume snapshot; Postgres — restore from
  backup. See [../operations/troubleshooting-production.md](troubleshooting-production.md).

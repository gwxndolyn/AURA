# Installation

Zero-config. No API key, Docker, Redis, or Postgres required to run.

## Prerequisites

- Node.js 20+ and npm.
- (Optional) Docker — enables the **real** code-execution sandbox.
- (Optional) `ANTHROPIC_API_KEY` — enables real Claude agents (otherwise
  simulation mode).

## Steps

```bash
cp .env.example .env     # if you don't already have a .env
npm install              # installs deps
npm run db:push          # create the SQLite schema (prisma/dev.db)
npm run db:seed          # seed the "NOVA PAY" demo company
npm run dev              # http://localhost:3000
```

Or the one-shot: `npm run setup` (= `db:push` + `db:seed`), then `npm run dev`.

> ⚠️ **If this repo lives in a cloud-synced folder (OneDrive/iCloud/Dropbox)**, you
> must relocate the build output. See [troubleshooting.md](troubleshooting.md) —
> start with `AURA_DIST_DIR=/tmp/aura-next npm run dev`. This applies to this
> machine. Never run a bare `npm run dev`/`build` here.

Verify the install:

```bash
npm run typecheck        # tsc --noEmit  → exit 0
npm test                 # Vitest unit tests
curl -s localhost:3000/api/health | npx --yes json 2>/dev/null || curl -s localhost:3000/api/health
```

`/api/health` reports each subsystem (DB, Claude mode, Docker sandbox, Redis,
event stream). `/api/ai/status` reports AI mode, models, budget, and sandbox mode.

## What got installed

- Next.js 15 + React 18 app (single process).
- Prisma client generated against `prisma/schema.prisma` (SQLite).
- A seeded demo company owned by `founder@aura.local`.

Next: [local-development.md](local-development.md) ·
[environment-setup.md](environment-setup.md) · [first-feature.md](first-feature.md).

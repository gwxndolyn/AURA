# Local development

## Everyday commands

See the full verified reference in [../operations/commands.md](../operations/commands.md).
The ones you'll use constantly:

```bash
AURA_DIST_DIR=/tmp/aura-next npm run dev   # dev server (note AURA_DIST_DIR on synced folders)
npm run typecheck                          # tsc --noEmit
npm run lint                               # next lint
npm test                                   # Vitest (unit)
npm run test:e2e                           # Playwright (needs test:e2e:install once)
npm run db:push                            # apply schema changes to SQLite
npm run db:seed                            # reseed demo data
```

## Inner loop

1. Pick the right **skill** for the task (`.claude/skills/`, catalog in
   [../README.md](../README.md#skills)) — it encodes the steps and checks.
2. Make the smallest vertical slice.
3. `npm run typecheck` and the relevant tests after each meaningful change.
4. Watch behavior live: open the app, use the feature, watch the activity feed
   (SSE). `/api/health` and `/api/ai/status` tell you what mode you're in.

## Modes you can toggle

| Toggle | Off (default) | On |
|---|---|---|
| `ANTHROPIC_API_KEY` | Simulation mode (deterministic agents) | Real Claude agents |
| Docker running | Simulated sandbox result (flagged) | Real code execution + tests |
| `REDIS_URL` / Postgres | In-memory bus + SQLite | External infra (`docker compose up -d`) |

Develop against the defaults; both the simulator and the real path are exercised
by tests. Set a key only when you specifically need to test the live path.

## Seeing changes in the real app

Use the `run` skill (or `AURA_DIST_DIR=/tmp/aura-next npm run dev`) to launch and
drive the app. The seeded demo company gives you populated agents, tasks,
deployments, findings, and metrics to work against immediately.

## Tips

- Path alias `@/*` → `src/*`.
- The DB is a file (`prisma/dev.db`); to reset demo data without nuking schema,
  re-run `npm run db:seed` (idempotent — it deletes the prior NOVA PAY demo first).
- Avoid `npm run db:reset` unless you truly want a force-reset; it drops data.

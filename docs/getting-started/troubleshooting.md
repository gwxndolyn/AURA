# Troubleshooting (local)

## OneDrive / cloud-synced folder: dev server hangs, `ETIMEDOUT`, fans spin

**Symptom:** `next dev`/`build` prints the banner then hangs (next-server never
starts), or crashes with `ETIMEDOUT: read` on `readFileSync`; load average climbs
to 20–40; `fileproviderd` pegs the CPU for minutes.

**Cause:** the repo is in a cloud-synced folder. Next.js writes `.next` constantly;
the sync daemon thrashes and Files-On-Demand evicts `node_modules`/`.next` to
cloud-only placeholders.

**Fix (always do this on this machine):** keep `.next` off the synced path.

```bash
AURA_DIST_DIR=/tmp/aura-next npm run dev
# or persist in .env:  AURA_DIST_DIR="/tmp/aura-next"
```

`next.config.mjs` honors `AURA_DIST_DIR`; `playwright.config.ts` already runs the
e2e dev server with `AURA_DIST_DIR=/tmp/aura-next-e2e`.

**Do NOT** `rm -rf .next` inside the synced folder — it triggers the eviction
storm. If you're already in a storm:

```bash
rm -rf .next                      # once, only if a stale .next is in the repo
# re-hydrate evicted files:
find node_modules -type f -print0 | xargs -0 -P12 -n100 cat >/dev/null
# wait until the 1-minute load average is < 5 before rebuilding
```

Builds/tests may take 10+ minutes while `fileproviderd` churns — that's the
environment, not the code.

## `db:seed` / `tsx` fails with EPERM on a pipe/listen

On this sandboxed machine, `tsx` needs its IPC pipe, which the OS sandbox blocks
(EPERM on listen). Run the seed with the sandbox disabled for that command only
(`npm run db:seed`). This is a machine constraint, not a code bug.

## Playwright: browser not installed

```bash
npm run test:e2e:install          # one-time; needs sandbox disabled (writes to ~/Library/Caches/ms-playwright)
npm run test:e2e
```

## "Agents feel scripted / costs are $0"

You're in **simulation mode** (no `ANTHROPIC_API_KEY`). That's expected and
intended for offline dev. Set a key in `.env` for live Claude. Confirm via
`GET /api/ai/status` (`mode: "live" | "simulation"`).

## "Tests pass but say (simulated), not (real sandbox)"

Docker isn't running, so the quality gate used the flagged simulated result. Start
Docker to get real `node --test` execution. Confirm via `GET /api/ai/status`
(`sandbox: "docker" | "simulated"`).

## Port 3000 in use

`PORT=3001 AURA_DIST_DIR=/tmp/aura-next npm run dev` (and set `NEXT_PUBLIC_APP_URL`
to match if you drive e2e).

## Schema changed but types/queries are stale

`npm run db:generate` to regenerate the Prisma client, then `npm run typecheck`.

## Production issues

See [../operations/troubleshooting-production.md](../operations/troubleshooting-production.md)
and the `aura-incident-response` skill.

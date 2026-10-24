# Coding standards

The guiding rule: **new code should read like the code already around it.** Match
naming, comment density, and idioms of the file you're in. Below are the AURA
specifics.

## Structure

- Domain logic in `src/lib/`, not in route handlers or components. Routes authorize
  + validate + call one domain function + shape the response.
- One responsibility per module. Workflows orchestrate; `lib/ai`, `lib/agents`,
  `lib/auth`, `lib/events` are the shared services.
- Import via the `@/*` alias, not deep relative paths.

## The choke points (never bypass)

| Need | Use | Not |
|---|---|---|
| A model call | `complete()` (`@/lib/ai/claude`) | `new Anthropic()` |
| An agent tool | `callTool()` (`@/lib/agents/tools`) | calling the impl directly |
| Company auth | `requireWorkspaceAccess()` (`@/lib/auth/authz`) | checking in the component |
| API response | `ok`/`err`/`handler`/`parseBody` (`@/lib/api`) | bare `NextResponse.json` |
| Realtime | `emitEvent()` (`@/lib/events/emit`) | writing `SimulationEvent` directly |
| DB | `prisma` (`@/lib/db`) | a new `PrismaClient` |

## Naming & types

- `camelCase` functions/vars, `PascalCase` types/components, `SCREAMING_SNAKE` for
  const tuples (`AGENT_STATUSES`, `ROLE_PERMISSIONS`).
- Enum-like values are string unions in `src/lib/types.ts` — reference those, don't
  re-declare literals. See [typescript-standards.md](typescript-standards.md).
- Domain functions take `companyId` as the first argument.

## Comments

Explain *why*, not *what*. The codebase uses a short block comment at the top of
each `lib` module stating its purpose and invariants — keep that convention when
you add a module.

## Styling

- Tailwind semantic tokens (`bg`, `border`, `text`, `brand`, `danger`, `success`,
  `warning`, `info`) — no raw hex in components. Compose classes with `cn()`.
- Reuse `src/components/ui/primitives.tsx`. Format numbers via `@/lib/utils`
  (`formatCurrency`, `formatNumber`, `formatPercent`, `timeAgo`).

## Dependencies

Avoid adding packages. Installs are fragile on the OneDrive filesystem and the app
is intentionally lean (see `package.json`). If you need one, justify it in the PR
and prefer a tiny, well-maintained library or a few lines of local code.

## Don'ts

- No secrets in code or client bundles (no `NEXT_PUBLIC_` on secrets).
- No raw SQL — Prisma only.
- No swallowing errors with empty catches or catch-all "success".
- No mocks standing in for real behavior just to pass a test.
- No `rm -rf .next` / bare `npm run dev` on this machine (OneDrive — see
  [../getting-started/troubleshooting.md](../getting-started/troubleshooting.md)).

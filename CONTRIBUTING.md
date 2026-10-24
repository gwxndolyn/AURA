# Contributing to AURA

## Setup

See [docs/getting-started/installation.md](docs/getting-started/installation.md).
TL;DR: `cp .env.example .env && npm install && npm run setup && AURA_DIST_DIR=/tmp/aura-next npm run dev`.

## Workflow

1. Branch from the default branch (the repo may not be git-initialized yet — if
   `git status` fails, initialize before committing).
2. Make the smallest vertical slice that satisfies the requirement. Use the
   relevant [skill](.claude/skills) and [workflow doc](docs/workflows/).
3. Add/adjust tests and **run them**.
4. Update docs for any changed contract (see
   [docs/README.md#maintenance](docs/README.md#maintenance)).

## Before you push — validation gate

```bash
npm run typecheck      # tsc --noEmit — must be exit 0
npm run lint           # next lint
npm test               # Vitest unit tests
npm run test:e2e       # if you changed a user journey (needs test:e2e:install once)
node scripts/check-docs.mjs   # if you touched docs
```

Do not mark work done with a failing typecheck, failing tests, or a partial
implementation. If something is blocked, say so — don't paper over it with a
catch-all or a mock. See
[docs/engineering/definition-of-done.md](docs/engineering/definition-of-done.md).

## Coding standards

- TypeScript strict; no `any` without justification. See
  [docs/engineering/typescript-standards.md](docs/engineering/typescript-standards.md).
- Reuse the service choke points (model/tool/auth/api/events) — see
  [AGENTS.md](AGENTS.md).
- Match the style of surrounding code (naming, comment density, idioms).
- Semantic Tailwind tokens, not raw hex. Primitives from `src/components/ui`.

## Commits & PRs

- Conventional, imperative commit subjects (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`). Explain *why* in the body for non-trivial changes.
- A PR should state what changed, what you tested, and any contract/doc updates.
- Keep PRs focused; large rewrites need a plan/ADR first
  ([docs/architecture/architecture-decisions](docs/architecture/architecture-decisions)).

## Security

Never commit secrets. Report vulnerabilities per [SECURITY.md](SECURITY.md). All
agent/AI changes must respect the permission and tenant-isolation model.

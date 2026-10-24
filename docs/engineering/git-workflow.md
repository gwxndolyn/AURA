# Git workflow

> The repo may not be git-initialized yet (`git status` currently reports "not a
> repository"). If so, `git init` before your first commit. These conventions apply
> once it is a repo.

## Branches

- Work on a feature branch off the default branch; don't commit directly to it.
- Short, descriptive names: `feat/task-pinning`, `fix/idor-agents`,
  `docs/api-design`.

## Commits

- Conventional, imperative subjects: `feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`, `perf:`.
- Subject ≤ ~72 chars; body explains *why* for non-trivial changes.
- Commit logically-grouped changes; keep schema changes with their type/query
  updates.

## Before committing

```bash
npm run typecheck && npm run lint && npm test
node scripts/check-docs.mjs     # if docs changed
```

Don't commit: `.env`, `prisma/dev.db` changes you didn't intend, `.next` / build
output, `node_modules`, or anything in `/tmp`. Check `.gitignore` covers these.

## Pull requests

State: what changed, why, how you tested (paste the commands + result), and any
contract/doc updates. Keep PRs focused. Large rewrites need a plan or ADR first.

## Attribution

When Claude Code authors commits/PRs here, follow the attribution lines configured
for the session (commit trailer + PR footer). Only add them when the current
session's instructions specify them.

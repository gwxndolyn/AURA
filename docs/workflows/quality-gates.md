# Documentation quality gates

Automated validation for the knowledge system. Run before pushing doc changes.

## Run it

```bash
node scripts/check-docs.mjs
```

Exit 0 = pass, 1 = problems. It prints a report either way. No external
dependencies (pure Node, uses only the standard library).

## What it checks (non-brittle — structural, not prose)

1. **Required docs exist** — the backbone files (CLAUDE.md, AGENTS.md, SECURITY.md,
   CONTRIBUTING.md, `.env.example`, the key `docs/` pages).
2. **Internal links resolve** — every relative Markdown link in `docs/` + root docs
   points at a real file (http/mailto/`#anchor`-only links are skipped).
3. **Skills are well-formed** — each `.claude/skills/<name>/SKILL.md` has YAML
   frontmatter with `name` + `description`, and `name` matches the directory
   (lowercase kebab-case).
4. **Env vars documented** — every variable in `.env.example` appears in
   `docs/operations/environment-variables.md`.
5. **Commands exist** — ``npm run <x>`` referenced in `docs/operations/commands.md`
   exists in `package.json` (reported as a warning, since the doc also lists
   intentionally-unavailable commands).

Warnings don't fail the build; problems do.

## When to run

- Before committing any docs change (see
  [git-workflow](../engineering/git-workflow.md)).
- As part of release readiness (`aura-release`).
- Periodically via the [documentation-audit prompt](../prompts/documentation-audit.md).

## CI

To gate docs in CI, run `node scripts/check-docs.mjs` as a step; a non-zero exit
fails the job. Keep it fast and dependency-free so it never blocks on install
flakiness.

## Extending it

Add a check only if it's structural and stable (won't fail on ordinary prose edits).
Good candidates: a new required doc, a new skill rule, a new env source. Avoid
asserting exact wording.

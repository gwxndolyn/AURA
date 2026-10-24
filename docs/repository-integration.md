# Repository integration

Code: `src/lib/factory/git.ts`, `webhooks.ts` · Routes:
`…/products/[pid]/repo` (GET state/diff, PUT connect) ·
`/api/webhooks/{github,gitlab}`.

## What exists

| Capability | Status |
|---|---|
| Per-product **real git repository** (bare repo under `AURA_GIT_ROOT`) | Verified |
| Verified work committed to isolated `aura/<task-key>` branches; default branch never written by agents; non-forced pushes only | Verified |
| Base-branch move detection (`expectBaseSha`) | Verified |
| Branch list, commit log and diff vs base in the UI | Verified |
| Project detection (language, framework, package manager, test command) | Verified (from files) |
| Push a branch to GitHub/GitLab + open PR/MR (idempotent per head branch) | Verified against a local bare remote and a mocked REST API · **live untested** |
| Webhooks: signature verification, idempotent deliveries, opt-in triggers | Verified |
| Cloning and *executing* arbitrary external repositories | **Not implemented** (see limitations) |
| OAuth / GitHub App installation flow | Not implemented — token by env var name |

## Connecting GitHub or GitLab

1. Create a **repository-scoped** token: GitHub fine-grained PAT with
   *Contents: read & write* and *Pull requests: read & write* on one
   repository (or a GitLab project access token with `write_repository` +
   `api`).
2. Put it in a server environment variable, e.g. `AURA_GITHUB_TOKEN`.
3. In the product's Repository tab (or `PUT …/repo`, ADMIN+) enter
   provider, `owner/repo`, https remote URL, default branch, and the **env
   var name**. AURA stores only the name; the API rejects values that look
   like a token rather than a name.
4. Optional webhooks: set a secret in another env var, enter its name as
   `webhookEnv`, and point the provider at
   `https://<host>/api/webhooks/github` (or `/gitlab`).

The token is sent to git as an `http.extraHeader` via `GIT_CONFIG_*`
environment entries (never in argv or URLs) and is redacted from errors.
git runs via `execFile` (no shell) with an isolated config
(`GIT_CONFIG_GLOBAL=/dev/null`, no prompts, fixed identity) and a 30 s timeout.
Paths are normalised (`devspace/paths.ts`) and writes inside `.git` are refused.

## Publication flow

Verified tasks → `aura/<key>` commits → **release candidate** branch
`aura/release-<n>` (tests re-run on the integrated tree) → approve RC →
**Request publish** creates an `external_publication` approval (ADMIN+) →
on approval AURA pushes the branch and opens the PR/MR, recording a
`GitOperation` with the URL. Merging is left to the repository's own review
and CI.

## Webhooks and automation

`(provider, deliveryId)` is unique, so duplicates are acknowledged and do
nothing. Each event (`push`, `pull_request`, `check_failed`,
`review_comment`) has a per-repository mode: `off` (default) · `report`
(timeline event) · `propose` (TODO backlog item) · `run` (READY item the
scheduler may dispatch within the product's autonomy, limits and approvals).
A push never edits code by itself. Event text is untrusted input.

## Limitations

- Execution needs a known test harness. The sandbox runs with
  `--network none`, so dependency installation for arbitrary repositories is
  not possible without weakening isolation; such tasks are honestly
  **not executable**.
- Release integration overlays the latest verified file contents; there is no
  3-way merge. A base move is detected and refused rather than merged.
- Review comments and CI status from providers are recorded/proposed but not
  yet threaded back into a specific PR revision loop.

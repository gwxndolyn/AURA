# Development workspace (Code)

> Source of truth: `src/lib/devspace/*` (paths, files, changes, checks),
> routes under `src/app/api/companies/[id]/devspace/*`, UI
> `src/app/app/[id]/code/page.tsx` + `src/components/devspace/*`. Tests:
> `src/lib/devspace/devspace.test.ts`, `devspace.api.test.ts`,
> `e2e/devspace.spec.ts`.

Users inspect the project's real files, review the exact changes agents made
(with provenance and evidence), run allowlisted checks in the Docker
sandbox, and decide whether to apply each change.

## What was reused

| Need | Reused |
|---|---|
| Project store | `CodeWorkspace` (files JSON = current revision) — extended with `revision`, per-file `fileRevs`, `template`. |
| Agent edits | Mission engine `CODE_CHANGE` tasks; their content stays in `MissionArtifact(FILE/DIFF)` — `FileChange` references the artifact, no duplicate copy. |
| Write-scope enforcement | `callTool` + `toolSpecs` (code.write refused outside the task's scope) — unchanged. |
| Verification | Mission QA/review evidence (`TEST_REPORT`, `MissionFinding`) + the existing Docker sandbox (`createWorkspace`, `execInSandbox`). |
| Diff | `missions/diff.ts` (line counts) and `@codemirror/merge` (rendering). |
| Events / auth | `emitEvent` (`CODE_CHANGED`, `TEST_STARTED/COMPLETED`), `requireWorkspaceAccess`, `audit`. |

New: `FileVersion` (immutable per-file history), `FileChange` (review
record), `ExecRun` (check runs); `Mission.workspaceId/baseRevision/baseFiles/
baseFileRevs`. Editor: **CodeMirror 6** (`codemirror`, `@codemirror/*`,
`@lezer/highlight`) — there was no editor before; Monaco was not chosen
because of its size and worker setup under Next.

## Version control

Project content lives in the database, so history is the `FileVersion`
table (one immutable row per file per applied project revision, with
sha256). There is no git checkout behind the project; nothing here invents a
parallel git format.

## File safety (`paths.ts`, `files.ts`)

- Paths: relative only; rejects `..`, `.`, empty segments, absolute/drive
  paths, backslashes, control characters, unusual characters, > 200 chars.
- Protected files (never editable here): `.env*`, `.npmrc`, keys/certs,
  `.git/`, `secrets*`. Shown read-only with a lock.
- Limits: 200 KB per file, 500 files per project, no binary content.
- `applyWrites` is all-or-nothing across files: per-file expected revision
  (stale writer → `ConflictError` naming the files, nothing written), then a
  compare-and-set on the project revision (concurrent writer → re-check).
- There is no server-filesystem browsing: the explorer lists the project's
  stored paths only. Checks write files to an ephemeral directory that is
  mounted into the container and deleted afterwards.

## Change lifecycle (`changes.ts`)

1. `startProjectMission` snapshots the in-scope files and their revisions
   from the current project revision into the mission (`baseFiles`,
   `baseFileRevs`); agents work on that snapshot.
2. After each code/test/review step, `syncMissionChanges` creates/updates ONE
   `FileChange` per (mission, file) — unique `syncKey`, safe under concurrent
   syncs. Its status mirrors the mission's own verification:

   `PROPOSED → VERIFICATION_PENDING → VERIFIED | VERIFICATION_FAILED`

3. A person decides: **accept** (ADMIN+) applies the proposed content with
   `expectedRev = baseRev` → `ACCEPTED` (applied as a new revision) or
   `CONFLICT` (the file moved; nothing written). Higher-risk changes
   (mission risk HIGH, or checkout/payment/auth/security paths) need an
   explicit confirmation. **Reject** (MEMBER+). **Revert** (ADMIN+) restores
   the pre-change content as a new revision, refused if the file changed
   again since. **Request revision** rejects and starts a new project mission
   with the note; it waits for plan approval.
4. Accept is refused while blockers exist: not VERIFIED, no passing Docker
   test run, open blocking findings, or a failing workspace check on the change.
5. A direct user edit to a file marks open agent changes to it as `CONFLICT`.

An agent finishing never sets ACCEPTED; only `acceptChange` (a human route) does.

## Checks (`checks.ts`)

Allowlisted ids only (`unit-tests` → `node --test`, `syntax` → `node --check`
over `*.js`). `lint`, `typecheck`, `build` are recorded as **UNSUPPORTED**
with the reason (no toolchain in the project/sandbox) — never as passing.

Execution uses the existing sandbox: `--network none`, memory/CPU/pids limits,
`--cap-drop ALL`, non-root, read-only image, wall-clock timeout
(`AURA_CHECK_TIMEOUT_MS`, default 30 s, 5–120 s), output capped at 32 KB
(truncation recorded). Runs can be run against the current revision or with
one proposed change overlaid. Each `ExecRun` records the command, revision,
status (PASSED / FAILED / TIMED_OUT / CANCELLED / ERROR / UNSUPPORTED), exit
code, pass/fail counts, failed test names and output. Cancellation kills the
named container (`aura-<random>`); runs orphaned by a server restart are
closed as ERROR on the next workspace load. At most two concurrent runs per
workspace. Without Docker a check is recorded ERROR "not executed".

## Preview

**Not available.** The sandbox has no network and exposes no ports, and AURA
has no separate isolated origin to serve project output from; rendering
project HTML inside AURA's origin would give it the user's session. The
preview tab says so.

## API (`/api/companies/[id]/devspace/*`)

| Route | Role | Purpose |
|---|---|---|
| `GET /` | VIEWER | tree, revision, capabilities, checks, preview status |
| `GET /file?path=` · `PUT /file` | VIEWER · MEMBER | read · save with `expectedRev` (409 on conflict) |
| `GET /history?path=` | VIEWER | file version history |
| `POST /import` | MEMBER | add the sample fixture files (never overwrites) |
| `POST /missions` | MEMBER | start a mission on the current revision |
| `GET /changes` · `GET /changes/[changeId]` | VIEWER | list · before/after/diff/provenance/evidence/blockers |
| `POST /changes/[changeId]` | ADMIN (reject: MEMBER) | accept / reject / revert / revise |
| `GET/POST /checks` · `GET/DELETE /checks/[runId]` | VIEWER/MEMBER | runs · run · detail · cancel |
| `GET /activity` | VIEWER | runs, findings, checks, change history from persisted rows |

All nested ids are re-scoped to the workspace (`findFirst({ id, companyId })`).

## Known limitations

- Agent edits apply only to the bundled fixture modules (the mission engine's
  executable repos); arbitrary project files are inspect/edit-by-user only.
- In simulation mode the engineer applies prepared repair candidates
  (labelled); tests and probes still execute for real.
- One change per file per mission; multi-file atomic acceptance is supported
  by `applyWrites` but the fixture missions change one file.
- No application preview; no lint/typecheck/build toolchain in the sandbox.
- History retention: `FileVersion` keeps full content per revision with no
  pruning yet (bounded by the 200 KB file limit).

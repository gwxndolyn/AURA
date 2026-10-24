# Verification and release

## The build → verify → repair loop

Each executable task is dispatched as a **mission** on the product's
codebase (reusing `src/lib/missions`). The mission plan is
`requirements → architecture → reproduce → fix → verify → review
[→ security-review] [→ approve-release] → report`:

1. **Reproduce** runs the existing tests in the Docker sandbox and records
   which fail.
2. **Fix** — the backend engineer edits only the task's write scope
   (enforced by `callTool`, not by prompt). With an API key the model's file
   content is applied; without one the fixture's prepared candidate for that
   round is applied and labelled `simulated-candidate`.
3. **Verify** re-runs the suite in Docker. Results decide; the implementer's
   description does not.
4. **Review** — the reviewer may only raise blocking findings it can back with
   an **executed probe** (a test it runs against the changed code). Unsupported
   concerns are recorded as `unsupported` and never block.
5. A failing test or supported finding starts a bounded repair round
   (`maxRepairs`); the fix must reference the finding it addresses.

Back at the product level (`scheduler.ts`), the persisted mission report
decides the task:

| Mission outcome | Backlog status | Verification |
|---|---|---|
| COMPLETED, final tests ran in Docker, 0 failed, all criteria met | VERIFIED | PASSED |
| COMPLETED but tests not executed / criteria not met | BLOCKED | INCONCLUSIVE |
| FAILED | FAILED → REPAIR item (or BLOCKED after `maxAttempts`) | FAILED |
| CANCELLED | FAILED | NOT_RUN |

Evidence on the task: test run (counts + where it ran), diff (+/−, author
label), findings (with status), mission outcome, and later the commit.

## Release readiness

`GET …/release` evaluates, from persisted state only, and reports each check
as **passed / failed / not run / not applicable**: scope approved ·
executable tasks verified · non-executable tasks accepted · no open blocking
findings · deterministic security checks · integrated release-candidate
tests · remote repository · migrations · deployment target · monitoring ·
rollback. `productionReady` is always `false` from AURA's side: it never
declares readiness on its own, and passing tests alone never imply it.

## Release candidate

Requires every executable task VERIFIED and no open blocking findings.
AURA commits the latest **tested** content of each verified task onto
`aura/release-<n>` (refusing if the base moved), **re-runs the test suite on
the integrated tree in Docker**, records the diff stat and commits, moves the
product to RELEASE_READINESS and requests approval. The approval lists every
check that did not run.

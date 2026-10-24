# User guide

Only workflows that exist are described. Unfinished ones are marked.

## Start

1. Register at `/register` (or log in), create a workspace in onboarding.
2. Pick a path:
   - **Products** (`/app/<ws>/products`) — build something from an idea.
   - **Code** (`/app/<ws>/code`) — work on the workspace project directly:
     import the sample, edit files, run checks, review agent changes.
   - **Missions** — one-off engineering tasks (e.g. "find and fix the
     validation bug").
   - **Office** — the visual view of the same work (see [office-experience.md](office-experience.md)).

## Build a product from an idea

1. **Products → New product idea.** Describe it (≥ 20 characters) or use the
   example. AURA creates the product, a brief (v1), a small backlog, a git
   repository and a **scope approval** request. Nothing runs yet.
2. **Brief** tab — problem, personas, requirements (FR/NFR), acceptance
   criteria, MVP / out of scope, journeys, editable assumptions, material open
   questions with their defaults, risks, milestones. The badge says whether the
   PM model or the deterministic template drafted it. **Edit** saves a new
   revision; changing requirements flags affected backlog items and asks you to
   re-approve the scope.
3. **Backlog** tab — epics → stories → tasks with keys, estimates (points, not
   time), dependencies, owner capability, files, verification required.
   "Not executable" means no codebase/test suite covers the task.
4. **Approvals** → approve the scope.
5. **Run team.** Each click runs bounded scheduler ticks. Design and
   architecture tasks produce artifacts; ready code tasks are dispatched as
   missions.
6. **Design** tab — review the wireframe (desktop/mobile), states, tokens and
   accessibility list. **Approve** creates the developer handoff; **Request
   revision** with feedback produces a new version.
7. **Run team** again. The code task runs: tests are reproduced in the
   sandbox, the engineer changes only the scoped files, tests re-run, the
   reviewer runs probes; failures start bounded repairs. Open the task to see
   its evidence (test run and where it ran, diff, findings, commit) and links
   to the mission and the code workspace.
8. **Repository** tab — branches (`aura/<task>`), commits and the diff.
9. **Release** tab — readiness checks (passed / failed / not run / n/a).
   **Build release candidate** integrates verified work on
   `aura/release-<n>` and re-runs the tests; approve it under Approvals.
   **Request publish** (needs a connected GitHub/GitLab repo) and **Request
   production deploy** create ADMIN approvals. Production deployment is
   **not available** until a deployment provider is configured; the request
   says what is missing.

## Task statuses

| Status | Meaning |
|---|---|
| todo / ready | waiting on dependencies / can be dispatched |
| in progress / in review | a mission is running / an artifact awaits your review |
| verified | sandbox tests passed, review passed, acceptance met — set only by evidence |
| accepted · unverified | a person accepted non-executable work (e.g. a design) |
| failed | verification failed; a repair task is created if within limits |
| blocked | needs a person: reason shown (no executable codebase, limits reached, tests not executed) |
| cancelled | stopped |

## Controls

**Pause** stops new work and pauses running missions; **Resume** continues;
**Cancel** cancels running missions and closes pending approvals (verified
history is kept; a sandbox command already executing finishes and its result
is discarded). **Reopen** a blocked/failed task; **Accept unverified** only for
non-executable tasks; **Cancel task**.

Autonomy (ADMIN, via API `PATCH …/products/<id>`): `SUGGEST` (nothing
dispatches automatically) · `SUPERVISED` (default) · `BOUNDED` ·
`CONTINUOUS`. Publication and production always need approval.

## Troubleshooting

- "Waiting for a person to approve the scope" — approve under Approvals.
- Task BLOCKED "tests were not executed" — Docker isn't running; start it and
  Reopen the task. AURA never marks work verified without executed tests.
- Task BLOCKED "no executable codebase" — expected for UI/doc tasks on the
  sample; accept unverified or attach a repository with tests (not yet
  supported for arbitrary repositories).
- Publish fails "Remote not configured" — set the token env var named on the
  connection on the server (see [repository-integration.md](repository-integration.md)).

## Engineering view vs office view

Everything in the office links to the engineering pages (product, mission,
code). You never need the office to do work.

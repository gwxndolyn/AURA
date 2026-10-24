# Autonomous runtime (V6): running AURA unattended

Code: `src/lib/jobs/*` (queue, worker, registry), `src/lib/runtime/*` (goals,
schedule, breaker, improve, selfmod, observe, config) · UI: `/app/[id]/autopilot`
· API: `/api/companies/[id]/runtime/*`, `/api/health/ready` · Tests:
`src/lib/runtime/runtime.test.ts`, `e2e/autopilot.spec.ts`,
`scripts/acceptance-runtime.ts`.

## What must keep running

Autonomous work continues after you close the browser or end a Claude Code
session **only while these keep running**:

| Component | Required | Purpose |
|---|---|---|
| Database (`DATABASE_URL`) | yes | Every job, checkpoint, goal, schedule, worker heartbeat and event lives here. Nothing in memory is authoritative. |
| **Worker process**: `npm run worker`, or the web server with `AURA_WORKER=inline` | yes | Claims and executes jobs and runs the scheduler tick. **Without one, nothing advances**, and the UI says so. |
| Docker on the worker host | for code tasks | Runs project tests (sandbox) and self-modification tests. Without it, runs fail as `sandbox_unavailable`. |
| `ANTHROPIC_API_KEY` | for model tasks | Planning and agent turns. Without it, jobs fail as `provider_not_configured`. Nothing is simulated. |
| Web server (`next start`) | for the UI and API only | Not needed for work to progress when the worker runs separately. |

A browser tab, a Next.js dev server timer and a Claude Code session are
**not** schedulers. The scheduler is part of every worker.

## Execution model

- **Jobs** (`Job`): durable rows.
  - Fields: priority, `dependsOn`, `deadline`, `timeoutMs`, `concurrencyKey`,
    `progress`, `checkpoint`.
  - Every transition is appended to `JobEvent`: enqueued, claimed, progress,
    checkpoint, succeeded, retry_scheduled, dead, failed, cancelled,
    lease_reclaimed, released, timeout, deadline_missed, resumed.
- **Claiming**: `claim()` uses compare-and-set on status and lease, so two
  workers never run the same job. A job is eligible only when all of these
  hold:
  - its workspace's kill switch and the global kill switch are on
  - its `job:<type>` circuit breaker is not open
  - its dependencies SUCCEEDED (a failed dependency fails it)
  - the per-workspace and per-key concurrency limits leave room
  - its deadline has not passed (otherwise it fails)
- **Leases and heartbeats**: each worker writes `Worker.heartbeatAt` and
  extends its jobs' leases every ≤15 s. If a process is killed, its leases
  expire (`AURA_JOB_LEASE_MS`, default 120 s), another worker reclaims the
  job (`lease_reclaimed` event) and the next attempt resumes from the job's
  checkpoint.
- **Retries**: exponential backoff with ±20 % jitter, only for retryable
  errors (provider rate limit or outage, sandbox infrastructure, timeouts).
  A job ends DEAD after `maxAttempts`, and FAILED immediately when the error
  is not retryable.
- **Cancellation**:
  - `cancel` marks the job CANCELLED.
  - The worker aborts the handler's `AbortSignal`, either at the next
    heartbeat or through the handler's own `isCancelled` checks.
  - Builder runs also `docker kill` their sandbox container.
- **Graceful shutdown** (SIGTERM or SIGINT):
  - the worker stops claiming
  - running jobs get `AURA_SHUTDOWN_GRACE_MS` (20 s) to finish
  - jobs still running are **released** back to the queue, so the attempt
    is not counted
  - the worker row becomes STOPPED
- **Timeouts**: `timeoutMs` per attempt aborts the handler cooperatively
  and counts as a retryable `timeout`.
- **Circuit breakers**: 5 consecutive failures (`AURA_BREAKER_THRESHOLD`)
  open `job:<type>`. After the cool-down (10 min) a half-open probe runs.
  An admin can also reset a breaker.
- **Schedules** (`Schedule`):
  - specs: `every 15m`, a 5-field cron (UTC), or `once <ISO>`
  - the tick is lease-protected and the dedupe key is the slot time, so each
    slot fires once
  - slots missed while every worker was down fire once, not one by one

## Goals

`POST /api/companies/[id]/runtime/goals {kind, mode, request, limits?, schedule?}`.

Each **goal** is driven by `goal.advance` jobs. One job performs one bounded
step from the goal's persisted checkpoint and enqueues the next step.

- **Product goals** (`build_product` / `add_feature`) run:
  1. PM planning (model)
  2. scope approval
  3. scheduler ticks that dispatch real builder runs in the sandbox
  4. the delivery gate
- **`continue_product`** resumes an existing product's backlog.
- **`improve_aura`** runs one lab improvement cycle.

A goal is **COMPLETED** only when every executable task is VERIFIED from
sandbox evidence **and** every requirement is traced to verified work.
Otherwise it ends FAILED, BLOCKED (with the reason) or BUDGET_EXHAUSTED.
Release candidates and deployment stay separate human approvals.

| Mode | Role | What AURA may do on its own |
|---|---|---|
| SUPERVISED | MEMBER | Plan. It waits for a person at scope approval and at every consequential action. |
| AUTONOMOUS_DEV | ADMIN | Approve its own drafted scope, then implement, test, repair and commit to isolated `aura/*` branches. Publishing and deploying still need a person. |
| CONTINUOUS_IMPROVEMENT | ADMIN | `improve_aura` only. Results are proposals (an experiment or a selfmod branch). |
| PRODUCTION_OPS | OWNER | No goal kinds are enabled yet (no production provider is configured). |

**Limits per goal**:
- steps, wall time, estimated cost (provider-reported tokens × list price,
  labelled as an estimate), model calls, consecutive failures
- when a limit is hit, the goal stops as BUDGET_EXHAUSTED with its state
  saved
- an authorized person resumes it with higher limits

**Runtime limits per workspace**: maximum concurrent jobs, and maximum
concurrent jobs per key.

**Kill switch**: `POST runtime {action:"autonomy", enabled:false}` (ADMIN).
- The workspace's jobs are not claimed.
- Running goals are paused and their jobs cancelled.
- The `RuntimeSettings` row `companyId="*"` is the global switch.

## Self-improvement

- **Cycles**: `lab.cycle` jobs. Schedule one from the Autopilot page or with
  `POST runtime/schedules {jobType:"lab.cycle", spec}`. Each cycle:
  1. benchmarks the active configuration
  2. builds the evidence-ranked backlog
  3. runs an experiment only for a **registered candidate method** that has
     not been tried on this suite version
  4. records the decision through the lab rules (Docker evidence only;
     security methods need admin approval)
- **Limit**: `AURA_IMPROVE_MAX_CYCLES_PER_DAY` (default 6).
- **Code changes**: `attemptSelfModification()` (`selfmod.ts`) applies a
  bounded patch in a `git worktree` on branch `aura/selfmod/<id>`, then:
  - **Allow-list**: only builder heuristics, the lab runner and docs may be
    changed. Auth, permissions, sandbox, tests, benchmarks, lab decision
    rules, Prisma, package files and `selfmod.ts` itself are refused.
  - **Size cap**: at most 5 files and 200 lines.
  - **Tests**: run in `aura-selfmod:dev` with no network, non-root,
    dropped capabilities and memory/CPU/pids limits.
  - **Pass**: the change is committed on its branch. It is never merged.
  - **Fail**: the worktree and branch are deleted.
  - **Record**: every attempt is a `SelfModAttempt` row. Re-submitting the
    same failing patch is refused unless a justification is given.
- **Not implemented**: writing *new* candidate methods. When no registered
  candidate exists, a cycle reports that ("a new method must be written
  first") instead of inventing one. Model-generated patches are not wired
  into `attemptSelfModification` yet.

## Observability and alerts

`GET runtime` returns all of these, read from persisted rows:
- workers (online = heartbeat younger than `AURA_WORKER_STALE_MS`, 60 s)
- queue depth and oldest wait
- success rate and p50/p95 duration
- retries, recovery events, timeouts and checkpoints
- provider failures
- engine test pass rate
- estimated cost
- breakers, goals, experiments and schedules

**Alerts** are also stored as in-app notifications, de-duplicated per open
condition:
- no worker online while work is pending
- stalled jobs (expired leases)
- queue wait over 15 min
- open circuit breakers
- goals that are blocked or out of budget
- 3 or more rejected experiments in 24 h

There is no external paging channel. Wire the notifications into one if
needed.

## Production deployment

```bash
# 1. image (web + worker share it). The build needs the npm registry and binaries.prisma.sh.
docker build -t aura:latest .
docker build -f Dockerfile.selfmod -t aura-selfmod:dev .          # optional: self-modification tests
#    behind TLS interception: add --secret id=ca,src=/path/corp-ca.pem (not stored in the image)

# 2. database: PostgreSQL recommended for >1 worker (set provider in prisma/schema.prisma), then
npx prisma db push      # or prisma migrate deploy once migrations are generated

# 3. web tier (no worker inside); the entrypoint applies the schema, then execs `next start`
docker run -d --name aura-web -p 3000:3000 --env-file .env -e AURA_WORKER=external aura:latest web

# 4. one or more workers (needs the Docker socket for the code sandbox). `worker` execs node directly,
#    so `docker stop` (SIGTERM) drains gracefully; give it ≥30 s.
docker run -d --name aura-worker --restart=always --stop-timeout 30 --env-file .env \
  -v /var/run/docker.sock:/var/run/docker.sock -v /srv/aura/git:/srv/aura/git \
  -e AURA_GIT_ROOT=/srv/aura/git aura:latest worker
```

- **Required env**: `DATABASE_URL`, `AUTH_SECRET` (16+ characters),
  `ANTHROPIC_API_KEY`, and a durable `AURA_GIT_ROOT` shared by web and
  workers.
- **Optional env**:
  - `AURA_WORKER_CONCURRENCY` (2), `AURA_JOB_LEASE_MS` (120000),
    `AURA_SCHEDULER_TICK_MS` (15000), `AURA_SHUTDOWN_GRACE_MS` (20000)
  - `AURA_SELFMOD_REPO` (a git checkout of AURA, for self-modification)
- **Startup checks**: the worker validates its configuration
  (`src/lib/runtime/config.ts`) and exits with code 2 on errors, so the
  process manager restarts it and surfaces the error. Secrets are never
  printed.
- **Readiness**: `GET /api/health/ready` returns 200 when the database and
  config are OK. `?requireWorker=1` also requires an online worker.
  Liveness is `GET /api/health`.
- **Restart and recovery**:
  - Restart a crashed worker; its expired leases are reclaimed automatically.
  - For a planned deploy, send SIGTERM (the default for `docker stop`) and
    give it 30 s. Running jobs are released, and the new worker resumes them.
  - Product runs left "running" with a dead job are moved to BLOCKED by the
    next scheduler tick (`recoverOrphanedBuilds`). Retry them from the UI.
- **SQLite**: fine for one worker. Use PostgreSQL to run several workers
  safely.

## Verification performed (2026-10-23, dev mirror)

| What | Result |
|---|---|
| `src/lib/runtime/runtime.test.ts` (21 tests) | passed: claim, no double execution, priority/deps/deadline/limits, backoff→DEAD, lease reclaim, checkpoint resume (each step ran exactly once), timeout, cancel, graceful shutdown release, kill switch (workspace + global), scheduler single-fire under concurrent ticks, cron parsing, breaker open/close, supervised goal waits for scope, budget stop + resume, duplicate advance, RBAC + tenant isolation, config validation, selfmod scope/rollback/commit/no-repeat |
| `scripts/acceptance-runtime.ts` | **11/11 checks passed** (run twice): an AUTONOMOUS_DEV goal ran through `npm run worker` processes. Worker #1 was SIGKILLed mid-run (`implement` phase); worker #2 reclaimed the build lease and continued. Goal COMPLETED, task VERIFIED, `npm test` exit 0 in Docker, artifact on `aura/e1.s1.t1`. History and final state were unchanged after a SIGTERM shutdown, re-read on a fresh DB connection; worker #2 STOPPED. **Model provider: HTTP test double**, not proof of live provider integration. |
| Real self-modification on an AURA clone | a patch weakening gate v2 → tests failed in `aura-selfmod:dev` → REVERTED (no branch, main clean); a doc-comment patch → tests passed in Docker (3.4 s) → COMMITTED on `aura/selfmod/v6-doc-comment`; a patch to `src/lib/auth/authz.ts` → REFUSED |
| `lab.cycle` job via the worker | SUCCEEDED; reported honestly that no untested registered candidate exists |
| `e2e/autopilot.spec.ts` (browser, `AURA_WORKER=external`) | passed: ping stays QUEUED with no worker; external worker started → SUCCEEDED; UI shows the worker online from its heartbeat; kill switch holds a new ping QUEUED; re-enabling → SUCCEEDED |
| Full Vitest suite | 377 passed, 2 skipped (docker-double file, skipped because real Docker works) |
| `next build` | passed |
| Container deployment (`aura:latest`, web + separate worker on a shared volume) | image built; `/api/health/ready?requireWorker=1` → 503 with no worker, 200 once the worker container heart-beats; worker container consumed a `runtime.ping` job from the shared DB; `docker stop` → worker logs `stopping`/`stopped`, row STOPPED, exit 0. The first attempt via `npm run worker` exited 1 on SIGTERM (npm does not forward signals), so the entrypoint now execs node directly |

**Not verified here**:
- the live Anthropic API (run `AURA_ACCEPTANCE_LIVE=1 ANTHROPIC_API_KEY=… npx tsx scripts/acceptance-runtime.ts`)
- a multi-worker deployment on PostgreSQL
- the code sandbox from *inside* the worker container (needs the host Docker
  socket mounted; the container check above ran without it)

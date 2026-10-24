# Engineering lab (V5): measuring and improving AURA's own engineering methods

Code: `src/lib/lab/*` · CLI: `npm run lab -- …` (`scripts/lab.ts`) · API:
`/api/companies/[id]/lab/*` · UI: `/app/[id]/engineering-lab` · Tests:
`src/lib/lab/*.test.ts`, `src/lib/builder/verdict.test.ts`.

## What it evaluates (and what it does not)

The lab runs AURA's **real pipeline functions**, the ones the builder engine
(`src/lib/builder/engine.ts`) calls, against a versioned benchmark suite:

| Kind | Pipeline component under test | Example |
|---|---|---|
| `gate` | `verificationPlan` → executed `npm test` → `buildIndex`/`analyzeChange` → `gateVerdict` | "a change that deletes the failing tests must be rejected" |
| `context` | `contextFiles` (what the engineer is shown) | "a task naming POST /api/users must surface the route + its test" |
| `diagnose` | executed failing command → `classify` / `signatureOf` | "a hung test is a timeout, not a code defect" |
| `impact` | `analyzeChange` test selection + flags | "a store change selects every dependent test" |
| `recover` | `recoverOrphanedBuilds` on real queue/build rows | "an orphaned run becomes BLOCKED; a live one is untouched" |

Each `gate` benchmark gives the pipeline a **candidate change**, a patch a
coding agent could plausibly produce, and states the correct decision.
**The model is not evaluated here.** Model and prompt quality is evaluated by
`src/lib/intelligence` and needs a live provider key. The lab measures the
deterministic engineering methods around the model, and it can do that
reproducibly and for free.

## Benchmark suite discipline

- `SUITE_VERSION` is bumped whenever any case changes. Runs on different
  versions are never compared.
- Each case has a **split**. Train cases may guide a change. Held-out cases
  are only used to check that it generalises. Once a held-out failure has
  been inspected to design a fix, it moves to **train**, and a new held-out
  batch is written **before** the fix (batches 4 → 5 on 2026-10-23).
- `benchmarks.test.ts` self-tests the suite: no no-op patches, consistent
  expectations. A no-op patch was found this way, and the experiment that
  used it was cancelled and re-run.
- Every case records its fixture hash, criteria with evidence, executed
  commands (exit code, output tail) and per-dimension measures.

## Executors

- **docker**: the same locked-down sandbox as the builder. Evidence is
  adoptable **only** from this executor.
- **host-trusted**: bundled fixtures only, on the host, with a minimal env.
  Enabled only with `AURA_LAB_HOST_EXECUTION=1`. Useful when Docker is down.
  Evidence from this executor is **never adopted**. On 2026-10-23, classifier
  v2 passed on the host (Node 24) but failed in the sandbox (Node 20), so
  host results do not transfer.

## Scorecard (no aggregate score)

`scorecard.ts` reports separate dimensions:

- functional (`casesPassed`, `correctAccepts`)
- engineeringQuality (`badChangeRejection`, `contextRecall`, `contextPrecision`, `impactCorrect`)
- autonomy (`diagnosisCorrect`, `recoveryCorrect`)
- reliability (`harnessErrors`)
- security (`securityRejections`)
- economics (time, sandbox ms, context size, `falseRejectRate`)

Each metric carries its numerator, denominator and formula. A metric with no
cases is `null`, never a guessed number. `criticalFailures` lists every
defective change that was accepted, so a failure cannot be averaged away.
Dimensions that are not measured are listed with the reason: customer
experience, provider cost, and browser journeys.

## Experiments

An experiment records:

- problem
- **evidence** (required)
- hypothesis
- success and regression rules (`metric op value split`)
- procedure and reject-if
- baseline and candidate configurations

`runExperiment` runs both arms on the same suite, split and executor, then
`decide()` applies these rules:

- **REJECTED** if any of these hold:
  - a regression rule fails
  - the candidate newly accepts a defective change
  - held-out `casesPassed` drops
- **ACCEPTED** only if every success rule is met (not merely "measured").
  When the change is security-relevant (the arms differ in gate policy),
  the outcome is **AWAITING_APPROVAL** instead, and an ADMIN decides.
- **INCONCLUSIVE** otherwise. The result is kept, never promoted.
- **Rejected approaches**: re-proposing a rejected `key` returns the earlier
  rejection evidence, unless `force` is given with a reason.
- **Adoption**: the `activeConfig` changes only when all of these hold:
  - the experiment's baseline equals the active configuration
  - the result came from the Docker executor
  - the outcome was accepted or approved
- Changing an engine default is a separate, reviewed code commit, made with
  a comment that cites the experiment. The lab never edits code or the
  environment on its own.
- Only one experiment runs at a time per workspace. Start via the API
  queues a durable `lab.experiment` job.

## Durable loop state and resumption

`LabState` holds:

- objective and status (IDLE / RUNNING / PAUSED / BLOCKED)
- active experiment and active configuration
- evidence-ranked backlog (`proposeBacklog`, built from failing cases)
- blockers and known regressions
- next action and resume instructions

`verifyState()` runs on every CLI command and API read. It never trusts the
stored status:

- runs and experiments left RUNNING by a dead process are marked
  INTERRUPTED (they can be re-run, since runs are idempotent)
- a dangling `activeExperimentId` is cleared

**No background controller exists.** The loop advances when a person or a
scheduler runs the CLI, calls the API, or a `lab.experiment` job is
processed by the worker. The UI shows the persisted status and says so. To
run the loop on a schedule, call `npm run lab -- run` (and `backlog`) from
cron or CI. Choosing *what to try next* still needs an engineer or agent to
write the candidate method and experiment spec. The lab supplies the
evidence-ranked backlog and the accept/reject discipline.

## Controls and authorization

- Reading lab data: VIEWER.
- Running suites, proposing, starting, cancelling, approving or rejecting
  experiments, and pausing or resuming the loop: **ADMIN**, enforced in the
  routes by `requireWorkspaceAccess`.
- A paused loop refuses runs and experiment starts (409).
- All lab data is scoped by `companyId`. Use a dedicated workspace
  (`AURA_LAB_COMPANY_ID`) for the lab.

## Results recorded on 2026-10-23 (lab workspace, `prisma/ci.db` in the dev mirror)

| Experiment | Executor | Outcome | Evidence |
|---|---|---|---|
| context-graph (lexical → graph) | host | ACCEPTED; adopted as code default | recall 0.5 → 1 (train and held-out), precision 0.50 → 0.69 |
| context-graph-docker (re-verification) | docker | ACCEPTED | recall 0.625 → 1 on suite -6 |
| diagnose-v2 (runner timeout message) | host | ACCEPTED on host; **failed in Docker** | led to the Docker-only adoption rule |
| diagnose-v3 (Node 20 cancelled-test wording) | docker | ACCEPTED; adopted as code default | diagnosisCorrect train 0.75 → 1, held-out 0.67 → 1 |
| gate-v2 (v1 → v2) | docker | INCONCLUSIVE | train rejection 0.25 → 0.75, held-out 0 → 0.6; misses tautologies, Function and vm |
| gate-v3 (v2 → v3) | docker | AWAITING_APPROVAL | train 0.75 → 1, held-out 0.6 → 1, 0 false rejects |
| gate-v3-from-v1 | docker | **AWAITING_APPROVAL** | defective changes rejected 1/12 → 12/12, correct changes accepted 100%; engine journeys pass with `AURA_GATE_POLICY=v3` |

Lab defects found and fixed by the lab itself:

- a no-op benchmark patch
- a benchmark that hit the executor timeout under every configuration (it
  did not discriminate)
- security relevance being inferred from the experiment's wording
- adoption carrying an unapproved method along with an approved one
- adoption from host evidence

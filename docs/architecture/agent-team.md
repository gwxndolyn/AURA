# The engineering agent team (AURA V9–V10)

How the customer pipeline (`src/lib/factory` + `src/lib/builder`) coordinates
specialised agents. Authority lives in code; prompts make agents better at their job,
never more powerful.

## Layers

| Layer | Where | What it does |
|---|---|---|
| Chief orchestrator (policy) | `src/lib/builder/orchestrator.ts` (pure, unit-tested) + `factory/scheduler.ts` | effective risk, review plan, gate policy, per-task input contracts, missing-input blocking, failure-category recovery, disagreement resolution, context package with provenance |
| Specialists | prompt library `src/lib/agents/prompts.ts` | PM, designer (incl. design-system ownership), architect, frontend, backend, QA, security, reviewer, release engineer |
| Execution | `builder/engine.ts` | real tools via `callTool`, engine-run verification in Docker, real-Chromium browser verification, bounded repair, commit |

The orchestrator is deterministic code, not another model: progress is measured by
verified work products, and no agent can mark its own work done.

## Prompt library

`PROMPT_LIBRARY_VERSION` (currently `2026.10.24-2`) is recorded on every run's
`AgentRun.promptRef` (`builtin:<agent>@<version>` or `library:<agent>.<task>@<version>` for
planning calls). Each role card has: identity, objective, responsibilities,
**non-responsibilities**, inputs, output, tools, decision rules, collaboration, quality
bar, done criteria, prohibited behaviour; engineering agents also carry the ten mandatory
`ENGINEERING_RULES`; all carry `SECURITY_RULES`. Planning calls (brief, backlog, change
plan, design, architecture) use the role card + a task instruction and are recorded as
AgentRuns (they used to bypass the registry).

Existing workspaces receive a new library version as a **DRAFT** prompt version — it is
promoted through the normal evaluate → approve → promote path, so a prompt change is
adopted on evidence and the previous version stays available for rollback.

## Per-task decisions (recorded on `Build.orchestration`)

- **Risk**: `max(planned risk, sensitive surface)` — auth, payments, migrations, sensitive
  data, concurrency and deployment raise a task to HIGH.
- **Review plan**: LOW → QA + code review; MEDIUM or any sensitive surface → + security;
  HIGH → every reviewer must return a valid explicit verdict (no implicit approval), and
  the stricter **v3 gate** applies (tautological/weakened tests, dynamic code).
- **Inputs**: the approved design handoff and architecture contracts **addressed to this
  task** and the story's **feature contract** are injected; their acceptance lines are
  merged into what QA verifies. The scheduler does not start a FRONTEND task (or a task
  depending on DESIGN/ARCHITECTURE work) until the required artifact is approved.
- **Dependencies**: a task's working tree merges the verified branches of the tasks it
  depends on (real `git merge`; a conflict blocks the run and preserves both branches).
- **Recovery** per failure category: environment → retry later (no code change asked);
  timeout → hang strategy; dependency / configuration / test-environment → specific
  instructions; recurring defect → rethink + stronger model; review findings / unproven
  criteria → address evidence. Identical-tree and recurrence stops prevent repeated
  failed repairs.
- **Disagreements**: evidenced blocking findings stand even if another reviewer approved;
  objections without evidence don't block (recorded); unparseable reviews get one
  corrective retry and are never silently treated as "no findings".
- **Context package**: product, brief, contract, architecture, design, task, repository,
  relevant files, code map, memory and failure feedback, each with provenance, recorded on
  `Build.contextManifest`.

## Browser verification (`src/lib/builder/browser.ts`)

For UI-visible changes, after the tests pass, the app runs in a Docker container on an
`--internal` network (no internet, no host access) behind a fixed relay; real Chromium
(playwright-core) visits each page at 1280×800 and 390×844 and records: HTTP status, page
errors, console errors, failed same-origin requests, horizontal overflow, unlabeled
controls/fields, possibly inert buttons, full-page screenshots, and a **create → reload →
persists** journey through the page's first form against the app's collection API.
Blocking findings go back to the engineer with route, viewport, observed vs expected.
Unavailable browser tooling is reported as "not run" — never as passed. Screenshots are
served through a tenant-checked route.

## Feature contracts (`src/lib/factory/contract.ts`)

One `FEATURE_CONTRACT` artifact per story, derived from the brief, tasks, approved
architecture and design (problem, behaviour, entry points, UI, API operations, data,
authorization, validation, states, acceptance, tests, evidence). Re-written as a new
version only when its definition changes; the tick reports verified tasks that must be
re-checked.

## Quality measurement

`deliveryScorecard` adds: journeys passed, browser-clean rate, accessibility issues,
repair success, criteria met, **unsupported completion claims** and security findings —
all from recorded runs, `unavailable` with a reason when there is no data. The gate has a
`browser` criterion (required for the financial profile, advisory for web-app because
browser tooling may be absent on a server).

## Benchmark

`src/lib/factory/v10.benchmark.test.ts` runs the expense-tracker request through the real
pipeline (model provider = test double; everything else real) and fails on unmet critical
criteria. Report written to `$TMPDIR/aura-v10-benchmark.json`. Result of the run on
2026-10-24: see `docs/implementation-status.md`.

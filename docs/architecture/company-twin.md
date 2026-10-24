# Company twin (planning simulation)

> Status: **Implemented** (deterministic engine, 3 scenarios, what-if, compare,
> timeline, adviser). A *secondary planning tool* — it never executes, deploys
> or mutates real work. UI: `/app/[id]/twin`. Code: `src/lib/twin/*`.

## What is real vs simulated

| Area | Provenance | Source |
|---|---|---|
| Operations map, department drawer | **operational** | `liveDepartments()` — agents, mission tasks, task runs, findings, incidents, deployments, ExecRuns (SEEDED missions excluded) |
| Performance metrics | **operational** | `operationalMetrics()` — each has definition, source, window, sample; `null` = insufficient data (<3 samples) |
| Scenarios, CEO decisions, what-ifs | **simulation** | `engine.ts` over synthetic `SIM-*` items |
| Timeline | both, labelled `provenance` | `companyTimeline()` |

The department → agent mapping (`departments.ts`) reuses the existing agent keys;
no parallel agent registry exists.

## Engine (`engine.ts`, pure)

Discrete-day simulation, `RULES_VERSION = "twin-rules-v1"`. Inputs: `ScenarioState`
(horizon, budget, capacity, items with effort/value/deadline/dependencies/blockers,
incidents), `Decisions` (allocation summing to 100%, feature ≥ 10%; 4 distinct
priorities; capacity within `CAPACITY_LIMITS`; verification gate; risk policy;
rollback) and a seed. Only QA defect draws use the seed (`seededRandom`).

Rules: priority weight × value × deadline urgency orders work; allocation share
scales throughput (`0.6 + 0.8·√min(1, 2.5·share)`); quality share lowers defect
rate; incidents remove engineering slots and block dependent items until infra
mitigates (rollback = ⅓ effort); security items wait for simulated approval
under cautious/balanced policy; unverified work with the gate off is *escaped*,
never *delivered*. `composite()` is a transparent weighted sum with its
components exposed — the UI never declares a "winner".

**The simulated risk policy and capacity never change real permissions,
approvals, worker limits or sandbox settings** — nothing outside `src/lib/twin`
reads `TwinConfig`.

## Persistence

`TwinConfig` (one per company, versioned compare-and-set, history, audit) and
`TwinRun` (scenario, kind baseline|what_if, baselineId, rulesVersion, seed,
inputs, initialState, transitions, result, sha256 `inputHash`/`resultHash` over
canonical JSON). A what-if copies the baseline's `initialState` and seed.
`verifyReproducible()` re-simulates and compares hashes. Discard deletes only
*unsaved* runs of one scenario in one workspace.

## API (`/api/companies/[id]/twin/…`)

| Route | Role |
|---|---|
| `GET /twin`, `/scenarios`, `/config`, `/runs?scenario=`, `/runs/[runId]`, `/compare?ids=`, `/timeline` | VIEWER |
| `POST /config` (preview impact, nothing persisted) | VIEWER |
| `PUT /config` (`expectedVersion`) | ADMIN |
| `POST /runs`, `DELETE /runs?scenario=`, `POST /runs/[runId] {action:"save"}`, `POST /advise` | MEMBER |
| `POST /runs/[runId] {action:"verify"}` | VIEWER |

Nested run ids are always loaded with `findFirst({ id, companyId })`; other
workspaces get 404. Runs are rate-limited (60/h/workspace). Simulation events are
emitted with `[SIMULATION]` and `ops.resourceType: "simulation"`.

## Adviser

`advise()` explains engine output; it never computes results or acts. Without an
API key it returns the engine's own review. With a key: FAST tier via
`claude.ts`, Zod-validated `{facts(refs), assumptions, forecasts,
recommendations, uncertainties}`; unknown refs → fallback.

## Tests

`src/lib/twin/twin.test.ts`, `twin.api.test.ts` (Vitest), `e2e/twin.spec.ts`
(Delivery Crunch acceptance: baseline → what-if → compare → timeline → save →
refresh → no live mutation → cross-workspace 404, plus a mobile viewport).

## Limitations

Scenarios are fixed fixtures (no user-authored scenarios). Live AI adviser
output is unverified (no key in CI). Metrics need ≥3 real samples before a rate
is shown.

# Demo mode

AURA has two demo surfaces. Both are labelled in the UI; neither is ever
presented as live AI execution.

## 1. Landing-page guided demo (`/`)

Labelled **"Demo · scripted replay"**. An 11-step walkthrough of one real
workflow, "Find and fix the validation bug in this form":

pick project → describe task → plan + owners → reproduce (tests fail) →
first fix → tests pass → reviewer finding F-1 (executed probes fail) → repair →
re-verified → evidence → review & decide.

What is real and what is scripted:

| Content | Source |
|---|---|
| Project files, both diffs | The real `checkout-validation` fixture and its prepared repair candidates (`src/lib/missions/repos.ts`) |
| Plan (7 tasks, owners) | Asserted equal to the real planner output for that template (`office.test.ts`) |
| Test and probe results (4/5 → 5/5 → probes 0/3 → 5/5 → probes 3/3) | **Recorded** from real Docker sandbox runs on 2026-10-20 (`src/lib/office/recording.ts`), replayed, not re-run |
| Agent movements and interactions | Scripted, marked demo |
| Accept / reject | Shown disabled — nothing is applied |

The demo makes **no backend calls**. Controls: Next / Back, ← / →, Replay,
Skip to the result, "Meet the team". The final step links to registration;
the same workflow then runs live in the workspace (Code page → sample
project, or Products).

Regenerate the recording (needs Docker; run outside the macOS sandbox on this
machine): `npx tsx scripts/record-demo.ts`. It refuses to write if the sandbox
isn't available, and the tests check the recording against the fixtures.

## 2. Demo workspace (in-app)

Per-user demo workspace with sample (SEEDED) missions that are read-only and
excluded from metrics and the live office; "run the example mission" executes
for real. Reset is scoped to that workspace. See
[architecture/missions-and-demo.md](architecture/missions-and-demo.md).

## Live vs demo at a glance

Live: product lifecycle, missions, sandbox tests, git, approvals, the
`/app/[id]/office` page ("live data" badge). Demo: the landing walkthrough,
seeded sample missions, and the legacy company simulator surfaces.

# Learning from every build (AURA V11)

`src/lib/learning/*` turns recorded engineering outcomes into durable,
evidence-linked knowledge, and feeds it back into real agent runs. It extends the
existing systems instead of replacing them:

| Concern | Reused | Added in V11 |
|---|---|---|
| Project memory | `factory/memory.ts` (VERIFIED/ASSUMPTION/STALE, provenance) | negative memory (`failed:` entries) from failed runs; file-existence check at retrieval |
| Task memory | `Build` row | `Build.taskMemory` (feedback + approaches per attempt, restored on resume), `Build.retrievalManifest` |
| Events | job queue + worker maintenance tick | `LearningEvent` (unique key → idempotent), `processPending()` |
| Outcomes | `Build`, `CommandRun`, `Defect`, `AgentRun` | `RunOutcome` (one per run, recomputed idempotently) |
| Failure analysis | `builder/debug.ts` classifier, orchestrator recovery | `FailureAttribution` with taxonomy, scope, evidence, confidence, verification of the fix |
| Recipes | — | `EngineeringRecipe` + `RecipeApplication` (platform-authored, UNVALIDATED until proven) |
| Prompt optimization | `intelligence/experiments.ts` (A/B, gates, promote, rollback), registry | `learning/optimize.ts` (problems → bounded DRAFT change → evaluate); simulation can never promote |
| Method optimization | `lab/lab.ts` decide() | per-category regression rejection (`categoryRegressions`) |
| Feedback | — | `UserFeedback` → criteria / instructions / browser / scope actions |
| UI | — | `/app/[id]/learning`, run view "Learning" panel |

## Lifecycle

```
engine: build.started ─▶ attempt.completed (each attempt, incl. interrupted ones) ─▶ build.finished (any terminal state)
                                │                                                     │
worker maintenance / learning.process job ─▶ processPending():                         │
   attempt.completed → attribute() → FailureAttribution (verification PENDING)         │
                       later passing attempt → earlier attributions VERIFIED           │
                       same category again   → FAILED (the fix did not work)           │
   build.finished    → collectOutcome() → RunOutcome, recipe outcomes, revalidate, negative memory
   rework.requested  → RunOutcome.reworkRequested + intent_mismatch attribution
```

Emits never throw into the engine; retrieval failures return an empty package —
**a build never depends on the learning subsystem**.

## Retrieval (what an agent sees)

`learningContext()` assembles one labelled section: CURRENT FACTS, ASSUMPTIONS,
WHAT FAILED BEFORE (negative memory + established root causes of earlier attempts of
this task, with whether the tried fix worked), RECOMMENDATIONS (applicable recipes
with real validation counts) and USER INSTRUCTIONS, prefixed by a precedence rule
(current code and requirements win). Feedback criteria are added to QA's checklist,
`browser_required` forces browser verification, `scope_strict` turns out-of-scope
file changes into blocking findings, reviewer instructions go to the code reviewer.
The manifest (refs and reasons only, no content) is stored on the run and shown in
the run view.

## Honesty rules (enforced in code)

- Unexecuted tests are never counted (`testsRun` counts only commands that ran).
- Infrastructure, budget and cancelled runs get their own outcome classes and are
  excluded (and listed) in quality rates; attribution never blames an agent for them.
- Attribution without supporting evidence is `UNKNOWN`; indirect evidence is a `HYPOTHESIS`.
- A recipe is VALIDATED only after ≥ 3 verified applications on ≥ 2 products with ≥ 60 %
  success; EXCLUDED applications are not in the denominator.
- Problems require the same agent-scoped cause on ≥ 2 runs; one success or failure is not a rule.
- Excessive retries are not rewarded: first-pass success and attempts-per-verified are reported.
- Prompt candidates are DRAFT; promotion needs the existing fresh regression run + gates,
  and is **blocked when the evidence came from the simulated provider**
  (`AURA_ALLOW_SIMULATED_PROMOTION=1` exists for automated tests only).
- Lab method experiments are rejected if any benchmark category regresses.
- Memory and feedback are workspace-scoped; recipes are platform-authored or
  workspace-discovered and never cross workspaces.

## Evaluation

`src/lib/learning/learning.eval.test.ts` (suite `learning-2026.10.24-1`, synthetic labelled
fixtures) covers the twelve V11 scenarios and writes `$TMPDIR/aura-learning-eval.json`.
The V10 pipeline benchmark additionally asserts the learning records of a real build.

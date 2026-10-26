# Product experience intelligence (V17)

AURA checks whether the products it builds are usable. It inspects the running
app in a real browser, reports specific, evidenced problems, fixes them through
the normal engineering pipeline, and accepts a fix only when a re-audit no
longer observes the problem. This runs inside the existing pipeline (jobs,
backlog, scheduler, builder, memory). It is not a separate design tool or
dashboard.

| Piece | Where |
|---|---|
| Rubric: dimensions, rule catalogue, severity/confidence, fingerprints, prioritisation, risk policy, metrics, journeys from the brief | `src/lib/experience/rubric.ts` (pure) |
| Inspectors: static source checks; real-Chromium inspection (axe-core, keyboard, focus, touch targets, overflow, clipped text, headings, inert controls, broken links, form validation and recovery probes, journeys) | `src/lib/experience/inspect.ts` |
| Audit job, persistence (dedupe, fixed only from evidence, reopened), finding → backlog task, settlement → re-audit, memory, read model | `src/lib/experience/service.ts` |
| Isolated app runtime (shared with build verification) | `src/lib/builder/browser.ts` (`startIsolatedApp`, `launchChromium`) |
| Job | `experience.audit` in `src/lib/jobs/registry.ts` |
| Scheduler hook | `settleExperience` in `tickProduct` (`src/lib/factory/scheduler.ts`) |
| API | `GET/POST /api/companies/:id/products/:productId/experience`, `POST …/experience/findings/:findingId` |
| UI | product page → **Experience** tab (`src/components/products/experience.tsx`) |
| Data | `ExperienceAudit`, `ExperienceFinding` (additive models) |

## How an audit runs

1. A member starts an audit (`POST …/experience`), or the scheduler requests a re-audit after a UX fix task is verified. One audit per product runs at a time, as a durable job with a timeout and cancellation.
2. The job checks out the product's **integration base**: the latest approved release, or the default branch before the first release.
3. **Static checks** run on the source:
   - animations without `prefers-reduced-motion`
   - focus outline removed with no `:focus-visible` replacement
   - many literal colour values and no tokens
   - ambiguous button labels (hypothesis)
   - lists with no empty state
4. **The app runs** in AURA's isolated container (internal network, read-only, cap-drop ALL, non-root, resource limits) behind a relay. This is the same mechanism build verification uses. If it does not start, a `page:load_failed` finding records the container log.
5. **Real Chromium** visits each page at each viewport. It uses the project's CSS breakpoints when they are declared; otherwise desktop 1280 and mobile 390. Per page and viewport:
   - axe-core with WCAG 2.0/2.1/2.2 A and AA rules
   - script errors, console errors and failed requests
   - horizontal overflow, clipped text, and touch targets under 24×24 px
   - unlabeled fields (a placeholder does not count as a label)
   - controls that have click handlers but cannot be focused
   - heading order
   - visible focus while tabbing
   - loading indicators that never resolve
   - a screenshot (visual record only)
6. **Interactions:**
   - every visible non-form button is clicked on a fresh page and watched for any effect (DOM change, request, navigation, dialog); a button with no effect is `control:inert`
   - same-origin links are fetched
   - each form is submitted empty, and must show native validation or an associated message
   - each form is submitted with the server's write response intercepted as a 500; the user must see an error and keep their input. No real data is touched.
7. **Journeys** come from the brief (journeys, functional requirements, acceptance criteria) and the app's real API. Each journey names the requirement ids it covers, so traceability comes from the existing brief and there is no second source of truth.
   - **load**: the start page loads without errors.
   - **create/persist**: fill the form → POST succeeds → the record is visible without a reload → it is still there after a reload.
   - **validation**: an empty submit is explained, and nothing invalid is saved (the collection is checked through the API).
   - Every step records the expected and the observed result. A journey that cannot be attempted is `not_run`, with the reason.

## Findings

Each observation maps to a rule in `RULES`; axe rules are mapped through `axeRule`. A finding records:
- dimension: task completion, clarity, interaction, accessibility, responsive, consistency, or feedback
- severity
- confidence: *confirmed* (observed in the browser), *likely* (a strong automated or static signal), or *hypothesis* (a clarity heuristic with no user research behind it)
- user impact and recommended fix
- the affected route, viewport, element and files
- requirements and journey
- evidence
- whether a manual or assistive-technology check is also needed

A failed **critical** journey is always severity *critical*.

Findings are **fingerprinted** (rule + journey + route + target, with volatile ids normalised) and upserted, so each issue has one row across audits. Status changes are based on evidence:
- **OPEN**: newly observed.
- **FIXED**: a later audit whose inspection method actually ran no longer observes it. A static-only audit never fixes a browser finding, because absence of evidence is not a fix.
- **REOPENED**: observed again after it was fixed (the reopen count increments).
- **ACCEPTED_RISK / DISMISSED**: an admin decision, recorded and audited. Critical findings cannot be dismissed.

**Regressions** are high or critical fingerprints present now that the previous completed audit did not show.

## Metrics

There is no single opaque score. `scoreAudit` reports each measure with its formula and data source:
- critical journeys passing / total
- all journeys passing / total
- broken controls
- open high/critical usability findings
- serious/critical axe violations
- all automated accessibility violations
- responsive failures
- forms with validation feedback / forms
- requirements verified end-to-end / brief requirements

The verdict is one of *blocked* (a critical journey or critical finding), *issues*, *no_blocking_issues*, or *unverified* (no browser session ran). When no browser ran, the browser-based metrics are `null`, shown as "not measured", never 0.

No satisfaction, conversion or task-completion rates are reported. No analytics integration exists, and this is stated in the audit's limitations.

## Closed loop and risk policy

`createTaskFromFinding` creates **one task in the existing backlog** under story `UX1`. The task carries:
- acceptance criteria: the problem is no longer observed, the journey passes, tests cover the behaviour, and existing tests pass
- the evidence
- the recommended fix
- an instruction to keep the product's existing design, tokens and components

The **normal scheduler and builder** then do the work, with the product's autonomy, approvals, budgets, parallel limits and adaptive strategy (V16). This means sandbox tests, real browser verification, and risk-planned reviewers.

`remediationPolicy` decides who may start the work:
- **auto**: confirmed or likely, localised, not sensitive. Any member may create the task.
- **approval** (admin only): sensitive flows (auth, payments, privacy, admin/roles), navigation or information-architecture changes, and shared components (files imported by 3 or more others).
- **recommend**: hypotheses. These are never turned into tasks automatically.

Attempts are bounded. After 2 failed fix tasks, the finding needs a person.

When the task is **VERIFIED**, `settleExperience` (on the scheduler tick) requests a **re-audit**. The finding becomes FIXED only if that re-audit no longer observes it; other findings remain open. The verified outcome is then stored in **project memory** (`ux:<rule>:<route>`, kind `defect_solution`, status VERIFIED, provenance being the task and the re-audit). If the fix task fails, the finding returns to OPEN with the attempt counted.

The builder's browser verification labels browser problems that an experience audit has **already recorded as open** on the base as *pre-existing*. They do not block an unrelated targeted fix, but they stay visible and are tracked on their own findings. Journey failures are never treated as pre-existing.

## AURA's own workspace (slice 5)

`e2e/experience.spec.ts` runs the same axe-core and keyboard checks against AURA's real UI in a real browser:
- products (project creation)
- the product page
- the Experience, Runs and Execution tabs

The test fails on serious or critical automated violations, and prints the others. Results are in the final report of the change that added this. Applying the full audit service to AURA itself (Next.js, authenticated) is not wired: the audit service runs the node-web product stack only.

## Limitations

- Automated checks (axe-core plus probes) do not prove WCAG 2.2 AA compliance. No screen-reader or manual assistive-technology testing is done; findings that need it are flagged `manualCheck`.
- Clarity and consistency findings are heuristics, labelled *hypothesis* or *likely*. No user research or analytics are connected.
- The runtime supports **node-web** products (`src/server.js`), as build verification does. Other stacks get static checks only, and this is recorded as a limitation.
- Journey generation covers load, create/persist and validation for JSON collection APIs. Multi-page flows, authentication flows and non-form interactions are not yet derived automatically.
- Contrast uses axe's computed colours. Images, gradients and overlays may need a manual check.
- There is no visual-regression diffing. Screenshots are stored as a visual record only; regressions are detected from findings, not from pixels.
- Requires Docker and Chromium (`playwright-core`). Without them, the audit records `browser: unavailable` and the verdict is *unverified*.

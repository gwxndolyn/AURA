# Repository map

Verified file-by-file guide. Path alias `@/*` → `src/*`. When you need to find
something, start here instead of grepping blind.

## Entry points

| Concern | Path |
|---|---|
| Root dev manual | `CLAUDE.md` |
| Landing page | `src/app/page.tsx` |
| App shell + dashboard | `src/app/app/[id]/page.tsx`, `src/app/app/[id]/layout.tsx` |
| Onboarding (create company) | `src/app/onboarding/page.tsx` |
| API routes | `src/app/api/**/route.ts` |
| Middleware (auth gate) | `src/middleware.ts` |
| DB schema | `prisma/schema.prisma` |
| Seed | `prisma/seed.ts` |

## `src/lib/ai/` — model layer

| File | Exports | Purpose |
|---|---|---|
| `claude.ts` | `complete`, `MODELS`, `hasApiKey`, `aiMode`, `CompleteParams`, `CompletionResult` | **The only** model entry point. Routes by tier; falls back to simulator with no key or on API error. |
| `simulator.ts` | `simulatedCompletion`, `simPlan`, `pickAttackScenario`, … | Deterministic offline engine. Dispatches on `kind`: `plan`, `architecture`, `code`, `review`, `test`, `security-finding`, `attack`, `defense`, `decision`, `ceo`, `analysis`, `summary`. |
| `pricing.ts` | `priceFor`, `estimateCost`, `PRICING` | Per-million token prices by model family; cost estimate. |
| `budget.ts` | `BUDGET`, `usageSummary` | Budget config + per-company usage aggregation. |

## `src/lib/agents/` — agent runtime

| File | Exports | Purpose |
|---|---|---|
| `definitions.ts` | `AGENT_DEFS`, `AGENT_BY_KEY`, `getAgentDef`, `AgentDef` | Registry of the 12 agents (key, name, role, tier, system prompt, capabilities). |
| `orchestrator.ts` | `runAgent`, `logToolCall`, `BudgetExceededError` | Runs one agent turn: status → focused context → `complete()` → `AgentRun` record → memory → events. |
| `memory.ts` | `remember`, `retrieveContext` | Short/long memory with keyword-scored retrieval (never dumps full history). |
| `permissions.ts` | `ALL_TOOLS`, `ROLE_PERMISSIONS`, `permissionsFor`, `isAllowed`, `ToolName` | Per-role tool allowlists. |
| `tools.ts` | `callTool`, `PermissionError`, `ToolError`, `ToolContext` | The tool runner: permissions, arg/result validation, write scope, timeouts, approval requirement, `ToolCall` audit. |
| `toolSpecs.ts` | `TOOL_SPECS`, `inScope` | Per-tool input/output schemas, timeouts, scope rules. |
| `capabilities.ts` | `CAPABILITIES`, `assignAgent`, `validateRegistry` | Typed capability registry + deterministic delegation. |
| `contracts.ts` | `OUTPUT_SCHEMAS`, `validateOutput`, `HandoffSchema` | Per-task-kind output contracts and the handoff contract. |
| `guardrails.ts` | `checkLoop`, `checkBudget`, `maybeWarnBudget`, `newGuardState`, `LIMITS` | Loop + budget hard-stops. |
| `messaging.ts` | `sendMessage`, `listMessages` | Structured inter-agent messages (`BUG_REPORT`, `HANDOFF`, `QUESTION`, `DECISION`, `NOTIFY`, `FEATURE_REQUEST`). |

## `src/lib/missions/` — mission engine

| File | Main export(s) | Does |
|---|---|---|
| `state.ts` | `canMission`, `canTask`, `MISSION_STATUS_HELP` | Mission/task state machines. |
| `graph.ts` | `findCycle`, `eligible`, `blockedByFailure`, `levels` | Dependency graph helpers. |
| `planner.ts` | `validatePlan`, `checkoutFixPlan`, `genericPlan`, `templateFor` | Plan schema + validation (tool allowlists, verification required). |
| `engine.ts` | `createMission`, `planMission`, `decidePlan`, `advanceMission`, `decideApproval`, `cancelMission`, `runUntilBlocked` | Leased, bounded step execution; file locks; repair loop. |
| `executor.ts` | `executeTaskRun` | One task attempt: context → budget → tools → validated output → handoff → run record. |
| `context.ts` | `assembleContext`, `fitToBudget` | Capability-driven, budgeted, provenance-tracked context. |
| `repos.ts` | `REPOS`, `repoFor` | Fixture codebases (checkout-fix, checkout-validation) with tests, probes, security checks. |
| `timeline.ts` | `missionTimeline`, `runDetail`, `handoffDetail`, `missionScorecards` | Read models for collaboration + scorecards. |
| `faults.ts` | `injectFault` | Test-only fault injection. |
| `report.ts` / `read.ts` | `buildReport`, `listMissions`, `missionDetail` | Read models from persisted rows. |
| `fixtures.ts` | checkout module + tests | Showcase codebase. |

## `src/lib/factory/` — product lifecycle

`lifecycle.ts` (phases, item status edges, readiness, roll-up, progress — pure), `policy.ts` (autonomy, action classes, limits), `brief.ts` (PM brief/backlog: model + labelled template), `design.ts` (designer spec + handoff), `artifacts.ts` (design/architecture review loop), `scheduler.ts` (bounded ticks → missions → evidence), `git.ts` (real git + GitHub/GitLab), `release.ts` (readiness, release candidate, approvals, deploy request), `webhooks.ts`, `read.ts`, `store.ts`. UI `src/app/app/[id]/products`. See [../product-lifecycle.md](../product-lifecycle.md).

## `src/lib/twin/` — company twin (planning simulation)

`engine.ts` (pure seeded rules), `scenarios.ts` (3 SIM fixtures), `runs.ts` (persist/reproduce/compare/save/discard), `config.ts` (versioned CEO decisions), `departments.ts`/`metrics.ts` (real data), `timeline.ts`, `adviser.ts`. UI `src/app/app/[id]/twin`, `src/components/twin/ops-map.tsx`. See [company-twin.md](company-twin.md).

## `src/lib/devspace/` — development workspace

| File | Main export(s) | Does |
|---|---|---|
| `paths.ts` | `normalizePath`, `isProtected`, `assertWritable` | Path, protection and size policy. |
| `files.ts` | `applyWrites`, `readFile`, `listTree`, `fileHistory` | All-or-nothing, revision-checked project writes + history. |
| `changes.ts` | `startProjectMission`, `syncMissionChanges`, `acceptChange`, `rejectChange`, `revertChange`, `requestRevision`, `saveUserEdit` | Agent change review lifecycle with provenance. |
| `checks.ts` | `runCheck`, `cancelCheck`, `CHECKS` | Allowlisted sandbox checks with cancellation and bounded output. |

## `src/lib/ops/` — operational intelligence

| File | Main export(s) | Does |
|---|---|---|
| `rules.ts` | `RULES`, `evaluateRules`, `DEFAULT_THRESHOLDS` | Deterministic, versioned health rules (fire / clear / unknown). |
| `snapshot.ts` | `loadSnapshot` | Workspace-scoped, bounded state the rules read. |
| `reconcile.ts` | `reconcile` | Findings dedupe, resolve, re-open, history, events. |
| `actions.ts` | `decidePolicy`, `recommendationsFor`, `executeAction` | Autonomy policy + actions over real services, audited. |
| `monitor.ts` | `runEvaluation`, `requestEvaluation` | Lease-guarded, interval-throttled evaluation runs. |
| `briefing.ts` | `buildBriefing`, `aiSummary` | Deterministic briefing + optional validated AI summary. |
| `fixtures.ts` | `SCENARIOS` | Synthetic detection-quality scenarios. |

`src/lib/demo/service.ts` — `ensureDemoWorkspace`, `resetDemoWorkspace`. See [missions-and-demo.md](missions-and-demo.md).

## `src/lib/workflows/` — domain workflows

| File | Main export(s) | Does |
|---|---|---|
| `plan.ts` | `planGoal(companyId, goal)` | PM turns a goal into strategy + assigned tasks. |
| `build.ts` | `buildGoal(companyId, goal)` | End-to-end "Build MVP": plan → architect → execute each → deploy. |
| `executeTask.ts` | `executeTask(companyId, taskId)` | One task through the quality gate: implement → build check → **real sandbox tests** → acceptance → DONE/REVIEW. |
| `selfHeal.ts` | `executeTaskSelfHealing(companyId, taskId, opts?)` | implement → real tests → QA bug report → fix → rerun; BLOCKED if attempts (default 3) exhausted. |
| `deploy.ts` | `runDeployment(...)`, `deployWithRetry(...)` | Simulated pipeline build→test→scan→deploy→health; retry with DevOps self-heal. |
| `approval.ts` | `requestDeploy(companyId, env)`, `resolveApproval(companyId, deploymentId, decision)` | Human approval gate for production deploys. |
| `security.ts` | `runAttackDefense(...)`, `runSecurityAudit(...)` | Red→blue cyber-range cycle; or a pure scan. |
| `sprint.ts` | `planSprint(companyId, opts?)` | Capacity-based autonomous sprint planning. |
| `prioritize.ts` | `scoreTask(input)`, `prioritizeBacklog(companyId)`, `PRIORITY_BASELINE` | Pure scoring: `2·impact + 2·urgency + 3·securityRisk + dependents − 0.5·effort`. |
| `reassign.ts` | `setAgentAvailability(...)`, `reassignFromUnavailable(...)`, `FALLBACK` | Reassign an unavailable agent's open tasks to a peer. |
| `conflict.ts` | `resolveConflict(args)` | Arbiter (default `architect`) decides between two agent positions on evidence; records a `Decision`. |
| `decide.ts` | `askCeo(companyId, q)`, `makeDecision(companyId, q)` | CEO Q&A / recorded decision grounded in real state. |
| `stressTest.ts` | `runStressTest(companyId)` | Runs all failure modes at once; returns invariant report (incl. an unauthorized-tool-call check). |

## `src/lib/company/`

| File | Exports | Purpose |
|---|---|---|
| `provision.ts` | `createCompany`, `ensureUser`, `INFRA_NODES`, `CreateCompanyInput` | Create a company + 12 agents + 9 infra nodes + sprint + workspace + customers. |
| `simulation.ts` | `tickDay`, `advanceDays` | Deterministic daily business sim (customers, revenue, infra drift, Metric snapshot). |
| `security.ts` | `computeSecurityScore`, `refreshSecurityScore`, `ScoreCategory` | Security score from real state across 8 categories. |
| `attention.ts` | `computeAttention`, `AttentionItem` | Actionable "Needs Attention" items from real state. |

## `src/lib/auth/` — security

| File | Key exports | Purpose |
|---|---|---|
| `authz.ts` | `requireUser`, `requireWorkspaceAccess`, `accessibleCompanyIds`, `AuthError`, `ROLE_RANK` | **The multi-tenant choke point.** |
| `session.ts` | `setSessionCookie`, `getSession`, … | HMAC-signed httpOnly cookie session (Node crypto). |
| `edge.ts` | edge-compatible verify | Used by `middleware.ts` (Web Crypto twin). |
| `password.ts` | scrypt hash/verify | Password hashing. |
| `service.ts` | `register`, `login`, password reset | Auth operations. |
| `rateLimit.ts` | `rateLimit(key, max, windowMs)` | In-memory rate limiting for auth routes. |

## `src/lib/` (shared) & realtime

| File | Exports |
|---|---|
| `db.ts` | `prisma` (singleton on `globalThis`) |
| `api.ts` | `ok`, `err`, `parseBody`, `ApiError`, `handler` |
| `types.ts` | union tuples + `LiveEvent`, `AcceptanceCriterion`, `EventType` (no Zod here) |
| `store.ts` | `useApp` (Zustand: companyId, toasts, command palette) |
| `utils.ts` | `cn`, `formatCurrency/Number/Percent`, `timeAgo`, `clamp`, `parseJSON`, `seededRandom`, `hashString`, `sleep` |
| `events/bus.ts` | `publish`, `subscribe` (in-process EventEmitter on `globalThis`) |
| `events/emit.ts` | `emitEvent`, `audit` |

## `src/lib/sandbox/`

| File | Purpose |
|---|---|
| `docker.ts` | `createWorkspace`, `execInSandbox`, `dockerAvailable` — locked-down container runner. |
| `runner.ts` | `runNodeTests`, `runSyntaxCheck` — run real `node --test` / `node --check` in sandbox. |
| `codegen.ts` | `generateFeature(title, description)` — keyword-chosen runnable templates (auth, validation, money, ratelimit, authz, generic). |

## Frontend

- `src/app/app/[id]/` pages: `agents`, `code`, `cyber-range`, `analytics`,
  `projects`, `deployments`, `incidents`, `infrastructure`, `decisions`,
  `activity`, `company`, `settings`.
- `src/components/`: `shell/` (nav, command palette, sim controls), `dashboard/`
  (attention panel, metrics), `ui/` (primitives), `cyber/` (topology), `agents/`,
  `company/`, `code/`, `auth/`. Tokens: `src/lib/theme.ts`.
- `src/hooks/`: live-event SSE hook + polling helpers.

> See [frontend.md](frontend.md) for the component-level detail.

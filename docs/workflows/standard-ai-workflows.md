# Standard AI workflows

Reusable patterns, mapped to AURA's real components. For each: responsible
components, data contracts, security boundaries, failure states, observability,
tests.

## A. AI-assisted feature development

```
user request → acceptance criteria → codebase inspection → implementation plan
  → code changes → automated tests → security review → human review (if needed)
  → merge & release
```
- **Components:** you + skills (`aura-feature`, `aura-code-review`, `aura-test`,
  `aura-release`). **Security boundary:** review gates risky changes before merge.
- **Failure states:** tests fail → fix before merge; security finding → block.
- **Observability:** test output, review findings. **Tests:** unit + e2e for the
  slice.

## B. Runtime AI request

```
request → authN/authZ → input validation → context retrieval → model request
  → output validation → permission-checked tool execution → persist + audit → respond
```
- **Components:** route (`handler`) → `requireWorkspaceAccess` → `parseBody` →
  `retrieveContext` → `complete()`/`runAgent` → validate output → `callTool` →
  prisma + `emitEvent`/`audit` → `ok`.
- **Data contracts:** Zod request schema; validated model output; `{ok,data}`
  envelope. **Security boundary:** authz + tool permission check; tenant scope.
- **Failure states:** 401/403/404, 422, model error → simulator fallback (flagged),
  tool denied → `PermissionError`, budget → `BudgetExceededError`.
- **Observability:** `AgentRun` usage, events, audit. **Tests:** route happy/deny
  paths; eval the model step.

## C. Autonomous coding agent (the quality gate)

```
task → planning → sandboxed implementation → tests → failure analysis
  → bounded repair attempts → security checks → approval gate (if needed) → deploy
```
- **Components:** `executeTask` / `executeTaskSelfHealing` → `generateFeature` →
  `runSyntaxCheck`/`runNodeTests` (Docker) → QA bug report → fix → rerun →
  `requestDeploy`/`resolveApproval` → `deploy`.
- **Security boundary:** code runs **only** in the sandbox; DONE requires **real**
  tests; production deploy gated.
- **Failure states:** tests fail → REVIEW/`BLOCKED` after `maxAttempts`; no Docker →
  flagged simulated result. **Observability:** `CODE_CHANGED`, `TEST_*`, `TASK_*`.
  **Tests:** `runner.test.ts`, stress test.

## D. Multi-agent handoff

```
task creation → agent assignment → structured handoff → result validation
  → next agent → workflow state update
```
- **Components:** `sendMessage` (HANDOFF) · `AgentMessage` · `resolveConflict`
  (arbiter) · `reassignFromUnavailable`. **Data contract:** typed `AgentMessage`.
- **Security boundary:** each agent keeps its own tool allowlist; no privilege
  inherited via handoff. **Failure states:** unavailable → reassign; conflict →
  arbiter `Decision`. **Observability:** `CHAT`/`DECISION_CREATED` events.

## E. AI incident response

```
detection → evidence collection → triage → human approval (if required)
  → containment → remediation → verification → closure
```
- **Components (simulated):** `runAttackDefense` — Ghost attack → Shield
  detect/contain → `Incident` + `SecurityFinding` → Atlas patch → Iris verify →
  `refreshSecurityScore`. **Real ops:** `aura-incident-response` skill.
- **Security boundary:** destructive/prod actions need approval; range stays
  isolated. **Observability:** incident timeline, audit, recomputed score.
  **Tests:** security cycle covered by the e2e workflow + stress test.

> Adapt these to the real implementation when it changes; keep the diagrams honest.

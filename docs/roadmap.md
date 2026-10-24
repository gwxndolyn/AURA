# Roadmap

Ledger with per-item evidence: [implementation-status.md](implementation-status.md).
A UI existing does not make a feature complete.

## Implemented and verified

- Product lifecycle: brief revisions, Epic→Story→Task→Repair backlog,
  explicit phase transitions with reasons/evidence, evidence-only VERIFIED.
- Dependency-aware scheduler with file-conflict avoidance, parallel limit,
  bounded repairs, escalation, pause/resume/cancel, lease-based recovery.
- Real execution through missions: sandbox tests (Docker), probe-backed review,
  bounded repair, reports.
- Designer agent + versioned design specs with wireframe review, revision loop
  and structured handoff; architecture artifact from inspected code.
- Real git per product; isolated branches; release candidate re-tested on the
  integrated tree; approval gates by action class.
- Webhook signature verification, idempotent deliveries, opt-in automation.
- Development workspace (editor, diffs, accept/revert, checks), missions UI,
  operations center, tenant isolation, RBAC.

## Implemented, not yet verified live

- PM / designer / architect / engineer **model** output (no API key in CI —
  deterministic templates and candidates are what the tests exercise).
- GitHub/GitLab push + PR/MR against real providers (tested against a local
  bare remote and a mocked API).

## In progress / next

1. Execute **arbitrary repositories**: clone into the sandbox, install
   dependencies through an allow-listed package proxy (keeping `--network
   none` for the test run), detect and run the project's own test command.
2. Live model code edits on those repositories within write scopes.
3. Product-level REPAIR dispatch exercised by a dedicated failure test.
4. Thread PR review comments and CI results back into a revision loop.
5. Real 3-way merge for release integration with conflict surfacing.

## Planned

- Deployment provider adapter(s) with provider-confirmed status, logs, health
  checks and rollback.
- Production telemetry connectors → OPERATE → investigation tasks.
- Browser-automation QA of built UIs against rendered previews.
- Optional background worker (instead of request-driven ticks).
- OAuth / GitHub App installation instead of env-named tokens.

## Deferred / out of scope

- Expanding the legacy company simulator, cyber range or company twin.
- Unattended production deployment (production always requires a person).

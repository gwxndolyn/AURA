# Deployment and operations

Two different things share the word "deployment" in this repository. Keep
them apart.

## 1. Deploying products built in AURA

**Implemented (V7)** with the `docker-host` provider — see
[operations/product-delivery.md](operations/product-delivery.md). The text
below describes the earlier placeholder flow, kept for history.

### Earlier placeholder (pre-V7)

No deployment provider adapter for products exists yet. **Request production
deploy** (ADMIN+) creates a `DEPLOYMENT` artifact with status
`NOT_DEPLOYED`, the target commit, a rollback note, and the list of what is
missing (provider adapter, environment credentials, health-check URL), plus
a `production`-class approval. Approving it records the decision and returns
`deployed: false`. Nothing is ever shown as deployed without a provider
confirmation and post-deploy health checks — there are none to confirm.

To add a provider: implement an adapter (build artifact → deploy → poll status
→ health check → rollback) behind the existing approval in
`release.ts#decideProductApproval` (`deploy_production`), store provider logs
on the DEPLOYMENT artifact, and only then mark it `DEPLOYED`. Production
telemetry (errors, health) would feed `OPERATE` → investigation tasks
(`OPS.*` backlog items, as webhooks already do).

## 2. The legacy simulated pipeline — **demo-only**

`src/lib/workflows/deploy.ts` and the Deployments page run a deterministic,
simulated pipeline for the company simulator. Nothing ships to a real host.
It is labelled as simulated and is not part of the product lifecycle.

## Operating AURA itself

- Run: `npm run build && npm start` (on OneDrive machines set
  `AURA_DIST_DIR`). Health: `GET /api/health`.
- Required in production: `AUTH_SECRET` (≥16 chars; the app refuses to start
  sessions without it), `DATABASE_URL` (Postgres recommended for multi-user),
  a durable `AURA_GIT_ROOT` (product repositories live there — back it up with
  the database), Docker on the host for real test execution.
- Optional: `ANTHROPIC_API_KEY` (live agents), repo token + webhook secret env
  vars (named per connection).
- Observability: every state change emits a persisted event
  (`TimelineEvent`, SSE), audits in `AuditLog`, and AURA's own health is
  monitored by the operations center (`src/lib/ops`). There is no external
  alerting channel.
- Backups: database + `AURA_GIT_ROOT`. Restoring one without the other leaves
  `GitOperation` rows pointing at missing commits.

See [operations/deployment.md](operations/deployment.md) for platform details.

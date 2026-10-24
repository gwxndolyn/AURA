# Production runbook

## Topology

One or more Next.js web processes + one or more worker processes, sharing a
database, a durable `AURA_GIT_ROOT` volume, and a Docker daemon for the
execution sandbox. A single node can run everything (`AURA_WORKER=inline`).

| Component | Notes |
|---|---|
| Database | PostgreSQL recommended for production (`DATABASE_URL`, change the Prisma datasource provider). SQLite is fine for a single node. |
| Git storage | `AURA_GIT_ROOT` on persistent disk. Back it up **with** the database. |
| Work dirs | `AURA_WORK_ROOT` on fast local disk; contents are temporary. |
| Sandbox | Docker on the worker host. Pull `node:20-alpine` (or `AURA_SANDBOX_IMAGE`) ahead of time. The worker needs access to the Docker socket; isolate the worker host from the web tier if you can. |
| Worker | `AURA_WORKER=external` on web nodes and `npm run worker` (one or more) on worker nodes. Jobs are leased; crashed workers are taken over after `AURA_JOB_LEASE_MS`. |

## First deployment

1. Set the environment (see [environment-variables.md](environment-variables.md)). Required: `AUTH_SECRET`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_APP_URL`, `AURA_GIT_ROOT`.
2. `npm ci && npx prisma db push` (schema sync), then `npm run build && npm start`.
3. Start the worker (`npm run worker`) unless `AURA_WORKER=inline`.
4. Check `GET /api/health` and `GET /api/ai/status` (`mode: live`, `sandbox: docker`).

## Billing (Stripe)

1. Create products/prices in Stripe matching `src/lib/billing/plans.ts`; set `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`.
2. Add a webhook endpoint `<APP_URL>/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_failed`; set `STRIPE_WEBHOOK_SECRET`.
3. Enable the Customer Portal in Stripe (plan changes, cancellation, payment methods).
4. Verify in **test mode** first (`sk_test_…`): run a checkout with a test card, confirm the plan in Settings → Billing changes only after the webhook arrives. Then switch to live keys.

## GitHub App

1. Create a GitHub App: permissions Contents (R/W), Pull requests (R/W), Metadata (R), Checks (R). Setup URL: `<APP_URL>/api/github/callback` ("Redirect on update" on). No webhook is required for the core flow.
2. Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`.
3. In AURA: Settings → Integrations → Connect GitHub.

## Email

Set `RESEND_API_KEY` and `EMAIL_FROM` (a verified sender). Without them, password-reset emails are recorded but not sent, and the UI says so.

## Operating

- **Logs**: one JSON line per event on stdout (`event`, `correlationId`, `jobId`, `buildId`). Secrets are redacted by key name and token pattern. Ship stdout to your log system.
- **Stuck work**: jobs in `RUNNING` past their lease are re-claimed automatically. `DEAD` jobs keep `lastError`; customers retry from the UI (product → Runs → Retry, or Retry planning).
- **Provider outage**: runs retry with exponential backoff (`AURA_JOB_BACKOFF_MS`) and then show as blocked with a retry button. No output is fabricated.
- **Sandbox outage**: runs are marked retryable (`sandbox_unavailable`) and resume when Docker is back.
- **Runaway cost**: per-plan monthly AI budgets are checked before every model turn; `AURA_DAILY_BUDGET_USD` remains a workspace hard stop.
- **Backups**: database + `AURA_GIT_ROOT` together; restore both to the same point in time.
- **Deleting a customer**: users delete their account from Settings → Account (requires cancelling paid plans first). This removes owned workspaces, repositories and history.

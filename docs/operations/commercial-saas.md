# Commercial SaaS operations (AURA V8)

How tenancy, billing, quotas, usage, secrets, audit and data lifecycle work, and what
an operator must configure before launch. Everything here is enforced on the server;
the UI only reflects it.

## Tenancy and roles

- A **workspace** (`Company`) is the tenant. Every company-scoped route calls
  `requireWorkspaceAccess` / `requirePermission` (`src/lib/auth/authz.ts`); non-members
  get **404**, members without the permission get **403** and an `ACCESS_DENIED` audit entry.
- Roles: **owner** (everything, incl. delete/transfer), **admin** (people, billing,
  integrations, secrets, production deploys, audit, export, archive, settings),
  **member** = developer (run and change code, preview deploys), **viewer** (read).
  The named permission matrix is `PERMISSIONS` in `authz.ts` and is unit-tested.
- Invitations (`src/lib/auth/members.ts`): ADMIN+, 7-day single-use token (only the
  sha256 is stored), accepted only by a signed-in user **whose email matches**, consume a
  seat until accepted/revoked/expired. Nobody grants a role above their own; only the owner
  grants admin; OWNER is only transferred (`/members/transfer`). The owner cannot be
  removed or leave.
- Background work stays tenant-scoped: `startBuild` refuses a product from another
  workspace; jobs, builds, artifacts and SSE are queried by `companyId`.
- Platform operators (`User.isPlatformAdmin`) get `/api/admin/overview` (aggregates only;
  every access recorded in `PlatformAudit`). Tenants get 404 there.

## Authentication and sessions

- scrypt password hashes, minimum 10 characters (common passwords refused).
- Signed session cookie (httpOnly, SameSite=Lax, Secure in production) carrying a `jti`
  and the user's `sessionVersion`. `getSession()` rejects signed-out tokens
  (`RevokedSession`) and tokens from before a password change/reset or "sign out
  everywhere" (`/api/auth/sessions`, `/api/auth/logout {everywhere:true}`).
- Login: identical response and comparable work for unknown accounts and wrong passwords;
  rate-limited per account (8/15 min) and per IP. Reset requests never reveal whether an
  account exists. Set `AURA_TRUST_PROXY=1` only behind your own proxy (otherwise the
  client IP header is ignored for limits).
- Email verification (`/api/auth/verify-email`), password change (`/api/auth/password`).
  One-time links are redacted in the email outbox table.
- CSRF: SameSite=Lax cookies + middleware rejects state-changing `/api/*` requests whose
  Origin/Referer is another site (`src/lib/auth/csrf.ts`; webhooks exempt). Add extra
  front-end origins with `AURA_ALLOWED_ORIGINS`.
- Production safety: the edge middleware never accepts tokens signed with the dev secret
  when `NODE_ENV=production`; `validateRuntimeConfig` refuses test-double `*_API_BASE`
  overrides and a Stripe key without a webhook secret.

## Plans, entitlements and quotas

- Plans are data: `config/plans.json` (override with `AURA_PLANS_FILE`; validated, invalid
  files fall back to the defaults with an error log). Limits: products, runs/month,
  concurrent runs, AI budget, sandbox minutes, seats, deploys/month, storage, max
  retention, GitHub connections; features: GitHub, PRs, deployments, production
  deploys, advanced agents (lab, goals), priority support.
- **Atomic quotas** (`src/lib/billing/entitlements.ts`): `UsageCounter` rows hold
  `used`/`reserved` per metric and period; `reserve()` is a compare-and-swap on a version
  column, so concurrent requests cannot exceed a limit (tested with 25 parallel requests
  against a limit of 10). Every hold is a `UsageReservation` (RESERVED → SETTLED |
  RELEASED). Runs hold a monthly-run unit and a concurrency slot; the slot is released when
  the run ends in any state, on cancel, on final job failure and by crash recovery
  (`recoverReservations` in the worker's maintenance tick releases expired holds).
- **Customer spending cap**: `Company.monthlyBudgetUsd` (Settings → Usage). The effective
  AI budget is `min(plan allowance, cap)`; work stops before it starts when reached.
- Quota errors are HTTP 402 with the limit, current use, in-flight holds and the upgrade
  path.

## Billing (Stripe, behind `src/lib/billing/service.ts`)

- Checkout sessions are created server-side (monthly or annual price ids:
  `STRIPE_PRICE_PRO[_YEARLY]`, `STRIPE_PRICE_TEAM[_YEARLY]`). Existing subscriptions change
  plan **in place** with `proration_behavior=create_prorations`. Downgrades that current
  usage would violate (seats, products, connections) are refused with the reason.
- Cancellation is at period end (`/billing/cancel`, `{resume:true}` withdraws it).
- The plan changes **only** from signed webhooks (`/api/billing/webhook`) or a server-side
  retrieval (`/billing/sync`, used after the checkout redirect). Webhooks are verified,
  idempotent per event id, ordered (older events never overwrite newer state), and a
  failed processing returns 500 so Stripe **retries** (the previous version acknowledged
  such retries as duplicates). Invoices (`invoice.*`) are stored and listed in Settings.
  `invoice.payment_failed` → `past_due` (access kept during dunning), `invoice.paid` → active.
- **Verification status:** all of the above is verified against an HTTP test double of
  the Stripe API (`test/doubles/stripe.ts`). **Live Stripe is unverified** until an operator
  runs one test-mode checkout end to end (see launch checklist).

## Usage ledger

`UsageEvent` rows carry metric, quantity, `basis` (`provider_reported` tokens/durations,
`estimated` cost at list prices, `counted`), model, product, period and a unique
`idempotencyKey`, so retried writes and duplicate events are ignored. `reconcileCounters`
repairs counters from the ledger. Customer-facing cost is always labelled an estimate.
Alerts (`commercialAlerts` in `src/lib/runtime/observe.ts`): quota ≥ 80 %, AI budget
reached, 24 h spend > 3× the 7-day daily average, ≥ 10 denied actions per hour.

## Secrets and artifacts

- Workspace secrets (`src/lib/security/secrets.ts`): AES-256-GCM with `AURA_SECRETS_KEY`
  (32 bytes, keep it in your secret manager), the workspace id bound as AAD (a row copied
  to another tenant fails to decrypt). Values are write-only through the API, never sent to
  models, decrypted only by the deployment runner for the names a target lists, registered
  for redaction, and every use is audited (`SECRET_ACCESSED`).
- **Deployment env vars come only from the workspace's store** — the AURA server's
  environment is never a source (previously any non-reserved server env var could be
  injected). Single-tenant self-hosters may allowlist names with `AURA_DEPLOY_ENV_ALLOWLIST`.
- Redaction (`src/lib/security/redact.ts`) scrubs credential shapes and known secret values
  from logs, audit entries, sandbox command output (before it is stored or shown to a model)
  and deployment logs.
- Downloads (source archives, run screenshots) are tenant-checked routes; screenshot files
  are only served from the evidence root.

## Audit trail

`AuditLog` has `category` (security, membership, billing, integration, execution,
deployment, secret, data, activity), `outcome` (success, denied, failure) and redacted
metadata. Application code never updates or deletes rows; they are removed only with the
workspace. Admins read it in Settings → Security (`/api/companies/[id]/audit-log`).
Sign-in events are written into every workspace the user belongs to.

## Data lifecycle

| Action | Who | What happens |
|---|---|---|
| Archive / restore product | admin | read-only, frees an active-product slot; restore returns it paused |
| Export | admin | JSON of the workspace's records (no secret values, hashes or credentials) + per-product source download links; audited |
| Retention | admin (≤ plan max) | after `retentionDays`, command output, deployment logs and tool payloads are erased by the maintenance tick; run records, usage and audit stay |
| Disconnect GitHub | admin | installation marked revoked; uninstall the App in GitHub to remove access entirely |
| Delete workspace | owner, name confirmation | refused while a paid plan still renews; stops runs and deployed containers, deletes rows and on-disk repos/trees |
| Delete account | user, password | refused while owning a shared workspace (transfer first) or a renewing paid plan |

**Not deleted by AURA** (stated in the API response and the UI): database/disk backups
until rotation, repositories pushed to GitHub, Stripe's customer/invoice records, the
email provider's delivery logs, stdout logs already shipped to your log store (they contain
no secret values), and payment webhook receipts (event id + type) kept for reconciliation.

## Launch checklist (external configuration still required)

1. `AUTH_SECRET` (≥ 32 random chars), `NEXT_PUBLIC_APP_URL=https://…`, `AURA_SECRETS_KEY`.
2. Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the four price ids; point a webhook
   at `/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.*`,
   `invoice.*`; enable the customer portal. **Run one test-mode checkout, upgrade, failed
   payment and cancellation before going live** — not done here (no credentials).
3. Email: `RESEND_API_KEY`, `EMAIL_FROM` (without them verification/reset/invite links are
   not delivered and the UI says so).
4. PostgreSQL for more than one web/worker process (quota CAS works on both; SQLite is single-writer).
5. A shared rate limiter (Redis/WAF) in front of `/api/auth/*` for multi-instance deployments.
6. Backups of the database **and** `AURA_GIT_ROOT`; legal review of terms/privacy.

# Product delivery (V7): from idea to a deployed, maintained application

Code:
- `src/lib/factory/*`: lifecycle, brief, scheduler, release, gate, `change.ts`, `base.ts`, `scorecard.ts`
- `src/lib/builder/*`
- `src/lib/deploy/*`: `providers.ts`, `service.ts`, `verify.ts`

UI: product page tabs **Deploy**, **Changes** and **Quality** (scorecard),
plus **Autopilot** for goals.

Tests:
- `src/lib/deploy/journey.test.ts`: the whole lifecycle on real Docker
- `e2e/product.spec.ts`: in the browser, through deploy and a change request

## Lifecycle, as implemented

| Stage | What runs | Persisted output | "Complete" means |
|---|---|---|---|
| Discovery + product management | PM model (strict, validated, with a corrective retry) | `ProductBrief` (requirements FR/NFR/AC, journeys, assumptions); backlog `BacklogItem` (epics → stories → tasks with acceptance criteria, dependencies, files, `requirements`) | brief + backlog validated; scope approved by a person (or by AURA in AUTONOMOUS_DEV goals) |
| Architecture / UX design | architect and designer agents (DESIGN / ARCHITECTURE tasks) | `ProductArtifact` DESIGN, ARCHITECTURE, HANDOFF | a person approves the artifact (`DONE_UNVERIFIED`, labelled; specs are not machine-verifiable) |
| Implementation | backend / frontend / QA engineer agents with real file and command tools in an isolated git worktree | commits on `aura/<task>` branches, `Build`, `CommandRun`, `ToolCall` | — |
| QA + test-and-repair | the engine runs the verification plan in the Docker sandbox: focused tests on impacted code, then the full suite, lint, type-check, build; defects; bounded repair; repeated-failure stop | `Defect`, `Build.impact`, findings | task **VERIFIED** only from passing engine checks plus reviewed acceptance criteria |
| Security review | security agent on every verified change; gate v1 (v3 awaits admin approval) | findings (blocking ones must cite evidence) | no open blocking finding |
| Release preparation | integrate verified branches (real `git merge`) on top of the latest approved release; re-run the whole suite in the sandbox | `RELEASE_CANDIDATE` artifact; `release_candidate` approval | integrated tests pass; a person approves the candidate |
| Deployment | release engineer (`devops`) through `callTool("deploy.run")`, which enforces the role allowlist and an APPROVED approval | `ProductDeployment` (preflight, provider ids, URL, logs) | the provider started it **and** verification passed |
| Production verification | HTTP checks against the **deployed URL**: health path (with bounded start-up wait), then the configured journey checks (status and expected text) | `ProductDeployment.health` | every check passes, otherwise the deployment is stopped and the previous version restored |
| Maintenance | change requests (`Changes` tab or `POST …/changes`), goals, defects, project memory, scheduled lab cycles | `CHANGE_REQUEST` artifact, `C<n>` story + targeted tasks, requirement `CR-n` | same evidence rules as the first build |

## Deployment

**Provider implemented: `docker-host`.** It runs the release as a hardened
container on a Docker daemon the AURA worker can reach: the local socket, or
a remote engine via `DOCKER_HOST` / TLS.

- **Image**: built from the exact release commit's files, using
  `node:20-alpine` (`baseImage` is configurable). `.env*` and `node_modules`
  are excluded, and dependencies install with `--ignore-scripts`.
- **Container hardening**:
  - runs non-root
  - read-only root filesystem, with `/tmp` as tmpfs and `/data` as a volume
  - `--cap-drop ALL`, `no-new-privileges`
  - memory, CPU and pids limits
  - `--restart unless-stopped`
- **Network**: bound to `127.0.0.1:<port>` by default. Use `0.0.0.0` together
  with `publicHost` to serve it publicly behind your reverse proxy or DNS.
- **Secrets**: the target stores env var **names**. Their values are read
  from the AURA server's environment at deploy time and are never stored.
  AURA's own secrets (`AURA_*`, `ANTHROPIC*`, `DATABASE_URL`, `AUTH_SECRET`,
  `STRIPE*`, `GITHUB*`) are refused.
- **Connection**: verified with `docker version` when the target is saved,
  and again in every preflight. A target is never shown as connected without
  that check.

**Release policy** (enforced on the server):
- **Production**: always needs a `deploy_production` approval (ADMIN+), at
  every autonomy level. `autoDeploy` is refused for production.
- **Preview**: needs a `deploy_preview` approval (ADMIN+), unless the target
  has `autoDeploy` and the product autonomy is BOUNDED or CONTINUOUS.

**Preflight** (persisted on the deployment):
- an approved release candidate
- integrated tests passed in the sandbox
- no open blocking security finding
- target connected (re-verified)
- declared secret env vars present
- migration safety: schema or migration files are flagged; AURA never runs
  destructive migrations
- the currently deployed version
- the rollback strategy

**Verification and rollback**:
- The new version replaces the instances actually running for that product
  environment (the provider is asked, not our records).
- If verification fails, the new container is stopped and the previous
  verified version is redeployed with the configuration it was verified
  with, then verified again. The result is `ROLLED_BACK`, with the evidence.
- Manual rollback (`action:"rollback"`) goes through the same approval.

**Not integrated**: managed platforms (Fly.io, Render, Vercel, Kubernetes),
because there were no credentials to test them here. Add one by
implementing `DeployProvider` (`verify`, `deploy`, `stop`, `stopEnv`,
`logs`). Approvals, preflight, verification, rollback and history stay the
same.

## Follow-up changes (maintenance)

`POST /api/companies/[id]/products/[productId]/changes {request}` (MEMBER)
queues a durable `product.change` job:

1. **Inspect**: the code index of the **integration base**, which is the
   latest approved release branch (or the default branch before the first
   release), plus the backlog, the live deployment and verified project
   memory.
2. **Plan**: the PM model returns 1–4 **targeted** tasks on existing files,
   validated so that file paths must sit inside the existing structure and
   dependencies only point to earlier tasks. It also lists the behaviour that
   must be preserved, which becomes story acceptance (`Still works: …`).
3. **Build**: tasks become story `C<n>` with requirement `CR-n`, and scope is
   re-approved. Builds start from the integration base, so already-released
   features are present. The full existing test suite re-runs; weakening an
   existing test is flagged, or blocks when that test was failing.
4. **Release and deploy**: the release candidate merges onto the previous
   release and is deployed through the same policy.

## Delivery scorecard

`GET …/gate` → `scorecard`. Every metric is computed from recorded rows,
with numerator, denominator and formula. With no data it shows
`unavailable` and the reason. The metrics:
- requirements satisfied
- acceptance-test pass rate
- build success rate
- regression rate
- defects after the first deployment
- recovery minutes
- deployment verification rate
- cost per verified task (estimate)
- time to first usable application
- evidence coverage

## Verified on 2026-10-23 (dev mirror, Docker Desktop 29.4.3)

`src/lib/deploy/journey.test.ts` passed 4 of 4 tests:
1. An idea became a model brief and a plan. The first attempt really failed
   `npm test` in Docker, a defect was recorded and repaired, and the task was
   VERIFIED with its code on the branch.
2. The release candidate was re-tested in Docker. A MEMBER could not
   configure a target or approve production (403). AURA's secrets were
   refused as product env vars. Nothing ran before approval. After the ADMIN
   approved, a **real container** ran at `127.0.0.1:<port>`; the test hit the
   deployed API independently, the `deploy.run` tool call was audited, and
   the gate showed `deployed` with journeys passed.
3. Rollback: a release with a failing health check was stopped and the
   previous version was restored and re-verified. The previous version kept
   serving and was still recorded as VERIFIED.
4. A follow-up change produced one targeted task on
   `src/routes/assessments.js` (no regeneration; the earlier task stayed
   untouched). It started from the release that contained the earlier fix,
   the original tests re-ran and passed, the second release was redeployed,
   and on the live app the original scoring and the new
   `GET /api/assessments/:id` (200 and 404) both worked. Scorecard: deploy
   verification 2/3, requirements 100 %. Another workspace got 404.

`e2e/product.spec.ts`, in the browser: sign up → plan → real run (failing
test → repair → verified) → release candidate → **Deploy** tab configures a
docker-host target (CONNECTED) → preflight passes → deploy → admin approves
→ the live URL shows and the test POSTs to the deployed API → the change
request is PLANNED against `src/routes/assessments.js`.

The model provider was the HTTP **test double** in all of these. Live model
quality, managed cloud providers, and public DNS/TLS for deployed apps are
**not verified**.

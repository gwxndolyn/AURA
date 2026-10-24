# AURA — your AI team. From idea to working software.

Describe what you want to build. AURA turns the idea into a structured plan,
coordinates AI agents to design and implement it in a real git repository,
runs the project's tests and checks in an isolated sandbox, repairs failures,
and delivers verified work as a branch or GitHub pull request you approve.

> 👩‍💻 Developers & AI agents: start at **[CLAUDE.md](CLAUDE.md)** and
> **[docs/README.md](docs/README.md)**. What is verified vs not:
> **[docs/implementation-status.md](docs/implementation-status.md)**.

## What works (verified by tests that were run)

| Capability | Status |
|---|---|
| Signup, sign-in, onboarding → first product, workspace isolation, account deletion | ✅ |
| PM planning (brief, stories, acceptance criteria, dependencies) through the model provider, schema-validated, durable job | ✅ (tested through a provider test double; live model untested here) |
| Engineering runs: tool-using agents edit a real git working tree; AURA runs install/test/lint/build in Docker; QA, security and code review judge real output; bounded repair; commit to `aura/<task>` | ✅ |
| Durable background jobs: leases, crash recovery, retries with backoff, idempotency, cancellation | ✅ |
| GitHub App: connect, choose repo, import/publish, push branch, open PR, PR + checks status, revoke | ✅ against the GitHub API test double + real git; needs your App credentials for live |
| Billing: plans, Stripe checkout + portal, signed webhooks, entitlements, monthly quotas, usage page | ✅ in test mode against a Stripe test double; needs your Stripe keys for live |
| Production deployment | ❌ not provided — AURA delivers verified PRs; deploy with your own pipeline |
| Non-Node.js projects | ❌ not executed yet |

## How it works

`describe → plan (approve scope) → design/architecture (review) → build → verify in sandbox → repair → commit → release candidate (re-verified) → pull request (approve)`

- [Product lifecycle](docs/product-lifecycle.md) · [Agent orchestration](docs/agent-orchestration.md) ·
  [Verification & release](docs/verification-and-release.md) · [Repository integration](docs/repository-integration.md) ·
  [Architecture](docs/architecture.md) · [Production runbook](docs/operations/production-runbook.md)

## Run locally

Prerequisites: Node 20+, git, Docker (required for engineering runs), an Anthropic API key.

```bash
cp .env.example .env          # set ANTHROPIC_API_KEY and AUTH_SECRET at minimum
npm install
npm run db:push
npm run dev                   # http://localhost:3000 (worker runs in-process)
```

OneDrive/iCloud folders: `AURA_DIST_DIR=/tmp/aura-next npm run dev`.

Optional integrations (see [environment variables](docs/operations/environment-variables.md)):
Stripe (`STRIPE_*`), GitHub App (`GITHUB_APP_*`), email (`RESEND_API_KEY`, `EMAIL_FROM`).

## Tests

```bash
npm run typecheck && npm run lint
npm test                  # Vitest; Docker-dependent tests skip (not fake) without Docker
npm run test:e2e:full     # Playwright with provider test doubles at the HTTP boundary
```

Automated tests never call paid providers: `test/doubles/` contains HTTP test
doubles for the model provider, Stripe and GitHub. Everything else — database,
jobs, git, Docker execution, authorization — runs for real.

## Deploy

See the [production runbook](docs/operations/production-runbook.md): web + worker
processes, Postgres, a durable `AURA_GIT_ROOT`, Docker on the worker host,
Stripe and GitHub App setup, logs and backups.

## Simulation lab

AURA's earlier company simulator (sim clock, fictional finance, cyber range,
simulated deploy pipeline, company twin) is kept for research and is **off by
default**. Enable with `AURA_SIMULATION_LAB=1` and `NEXT_PUBLIC_AURA_SIMULATION_LAB=1`.

## Developer guide

AURA ships a full developer knowledge system — documentation, reusable Claude Code
skills, a prompt library, engineering standards, and an AI-engineering handbook.
It's designed so humans and AI coding agents can develop AURA quickly, consistently,
and safely.

**Entry points**

- 🧭 [CLAUDE.md](CLAUDE.md) — the operating manual (identity, boundaries, navigation,
  required workflow, non-negotiable rules). Read first.
- 🤖 [AGENTS.md](AGENTS.md) — the short version for AI coding agents.
- 📚 [docs/README.md](docs/README.md) — the documentation index + skill catalog +
  maintenance policy.
- 🔐 [SECURITY.md](SECURITY.md) · 🤝 [CONTRIBUTING.md](CONTRIBUTING.md)

**By topic**

| Topic | Doc |
|---|---|
| Quick start | [docs/getting-started/installation.md](docs/getting-started/installation.md) |
| Architecture | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Repository map | [docs/architecture/repository-map.md](docs/architecture/repository-map.md) |
| Engineering standards | [docs/engineering/coding-standards.md](docs/engineering/coding-standards.md) |
| AI engineering handbook | [docs/ai-engineering/overview.md](docs/ai-engineering/overview.md) |
| Testing | [docs/engineering/testing-strategy.md](docs/engineering/testing-strategy.md) |
| Security | [docs/security/threat-model.md](docs/security/threat-model.md) |
| Deployment | [docs/operations/deployment.md](docs/operations/deployment.md) |
| Commands (verified) | [docs/operations/commands.md](docs/operations/commands.md) |
| Troubleshooting | [docs/getting-started/troubleshooting.md](docs/getting-started/troubleshooting.md) |

**Claude Code setup** — the repo includes `CLAUDE.md`, path-scoped rules in
[`.claude/rules/`](.claude/rules), 18 reusable skills in
[`.claude/skills/`](.claude/skills) (catalog in
[docs/README.md](docs/README.md#skills)), project
[`.claude/settings.json`](.claude/settings.json), and a copy-paste
[prompt library](docs/prompts/README.md).

**Common questions**

- Add a feature → [workflow](docs/workflows/adding-a-feature.md) / skill `aura-feature`
- Add an AI agent → [workflow](docs/workflows/adding-an-ai-agent.md) / skill `aura-ai-agent`
- Add a tool → [workflow](docs/workflows/adding-a-tool.md) / skill `aura-ai-agent`
- Connect a model provider → [workflow](docs/workflows/integrating-a-provider.md) / skill `aura-ai-integration`
- Test an AI workflow → [eval doc](docs/ai-engineering/evaluation-and-testing.md) / skill `aura-ai-evaluation`
- Debug a failure → [workflow](docs/workflows/fixing-a-bug.md) / skill `aura-debug`
- Secure an agent → [agent permissions](docs/security/agent-permissions.md) / skill `aura-security-audit`
- Deploy a change → [deployment](docs/operations/deployment.md) / skill `aura-release`

Validate the docs: `node scripts/check-docs.mjs`.

## License

MIT (sample/educational project).

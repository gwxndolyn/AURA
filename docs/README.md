# AURA documentation

The developer knowledge system for AURA. Start at the root
[CLAUDE.md](../CLAUDE.md) for the condensed operating manual; this index points
to the depth.

> **Accuracy policy.** Every doc here is written against the real code. Each page
> states whether a capability is **implemented**, **simulated**, or
> **unverified**. If you find a doc that disagrees with the code, the code wins —
> fix the doc (see [Maintenance](#maintenance)).

## Quick answers

| I want to… | Go to | Skill |
|---|---|---|
| Set up & run locally | [getting-started/installation.md](getting-started/installation.md) | — |
| Understand the system | [architecture/overview.md](architecture/overview.md) | — |
| Find a file | [architecture/repository-map.md](architecture/repository-map.md) | `aura-context-optimizer` |
| Add a feature | [workflows/adding-a-feature.md](workflows/adding-a-feature.md) | `aura-feature` |
| Add an API endpoint | [workflows/adding-an-api.md](workflows/adding-an-api.md) | `aura-api` |
| Change the database | [workflows/changing-a-database-schema.md](workflows/changing-a-database-schema.md) | `aura-database-change` |
| Add an AI agent | [workflows/adding-an-ai-agent.md](workflows/adding-an-ai-agent.md) | `aura-ai-agent` |
| Add an agent tool | [workflows/adding-a-tool.md](workflows/adding-a-tool.md) | `aura-ai-agent` |
| Integrate a model provider | [workflows/integrating-a-provider.md](workflows/integrating-a-provider.md) | `aura-ai-integration` |
| Fix a bug | [workflows/fixing-a-bug.md](workflows/fixing-a-bug.md) | `aura-debug` |
| Test an AI workflow | [ai-engineering/evaluation-and-testing.md](ai-engineering/evaluation-and-testing.md) | `aura-ai-evaluation` |
| Evaluate / A-B / promote a prompt | [ai-engineering/intelligence.md](ai-engineering/intelligence.md) | `aura-ai-evaluation` |
| Secure an agent | [security/agent-permissions.md](security/agent-permissions.md) | `aura-security-audit` |
| Deploy a change | [operations/deployment.md](operations/deployment.md) | `aura-release` |

## Map

- **getting-started/** — [installation](getting-started/installation.md) · [local-development](getting-started/local-development.md) · [environment-setup](getting-started/environment-setup.md) · [troubleshooting](getting-started/troubleshooting.md) · [first-feature](getting-started/first-feature.md)
- **product** — [product-vision](product-vision.md) · [user-guide](user-guide.md) · [architecture](architecture.md) · [product-lifecycle](product-lifecycle.md) · [agent-orchestration](agent-orchestration.md) · [repository-integration](repository-integration.md) · [verification-and-release](verification-and-release.md) · [deployment-and-operations](deployment-and-operations.md) · [office-experience](office-experience.md) · [demo-mode](demo-mode.md) · [roadmap](roadmap.md) · [implementation-status](implementation-status.md) · [audit](autonomous-product-factory-audit.md) · [production-readiness-audit](production-readiness-audit.md)
- **architecture/** — [overview](architecture/overview.md) · [repository-map](architecture/repository-map.md) · [frontend](architecture/frontend.md) · [backend](architecture/backend.md) · [database](architecture/database.md) · [api-design](architecture/api-design.md) · [events-and-jobs](architecture/events-and-jobs.md) · [agent-orchestration](architecture/agent-orchestration.md) · [sandbox-architecture](architecture/sandbox-architecture.md) · [missions-and-demo](architecture/missions-and-demo.md) · [multi-agent-collaboration](architecture/multi-agent-collaboration.md) · [operations-intelligence](architecture/operations-intelligence.md) · [development-workspace](architecture/development-workspace.md) · [company-twin](architecture/company-twin.md) · [engineering-intelligence](architecture/engineering-intelligence.md) · [engineering-lab](architecture/engineering-lab.md) · [autonomous-runtime](operations/autonomous-runtime.md) · [product-delivery](operations/product-delivery.md) · [adaptive-execution](architecture/adaptive-execution.md)
- **engineering/** — [coding-standards](engineering/coding-standards.md) · [typescript-standards](engineering/typescript-standards.md) · [backend-patterns](engineering/backend-patterns.md) · [frontend-patterns](engineering/frontend-patterns.md) · [database-patterns](engineering/database-patterns.md) · [api-patterns](engineering/api-patterns.md) · [error-handling](engineering/error-handling.md) · [testing-strategy](engineering/testing-strategy.md) · [git-workflow](engineering/git-workflow.md) · [code-review](engineering/code-review.md) · [definition-of-done](engineering/definition-of-done.md)
- **ai-engineering/** — [overview](ai-engineering/overview.md) · [model-provider-abstraction](ai-engineering/model-provider-abstraction.md) · [prompt-engineering](ai-engineering/prompt-engineering.md) · [structured-outputs](ai-engineering/structured-outputs.md) · [tool-calling](ai-engineering/tool-calling.md) · [agent-orchestration](ai-engineering/agent-orchestration.md) · [context-engineering](ai-engineering/context-engineering.md) · [memory-and-retrieval](ai-engineering/memory-and-retrieval.md) · [evaluation-and-testing](ai-engineering/evaluation-and-testing.md) · [token-and-cost-management](ai-engineering/token-and-cost-management.md) · [latency-and-reliability](ai-engineering/latency-and-reliability.md) · [prompt-injection-defense](ai-engineering/prompt-injection-defense.md) · [human-approval](ai-engineering/human-approval.md) · [production-ai-checklist](ai-engineering/production-ai-checklist.md) · [intelligence](ai-engineering/intelligence.md)
- **workflows/** — step-by-step task guides (see table above) + [checklists.md](workflows/checklists.md) + [standard-ai-workflows.md](workflows/standard-ai-workflows.md)
- **security/** — [threat-model](security/threat-model.md) · [agent-permissions](security/agent-permissions.md) · [secret-management](security/secret-management.md) · [sandbox-security](security/sandbox-security.md) · [tenant-isolation](security/tenant-isolation.md) · [secure-development](security/secure-development.md)
- **operations/** — [deployment](operations/deployment.md) · [environment-variables](operations/environment-variables.md) · [commands](operations/commands.md) · [monitoring](operations/monitoring.md) · [troubleshooting-production](operations/troubleshooting-production.md)
- **prompts/** — [prompt library index](prompts/README.md)

<a id="skills"></a>
## Claude Code skill catalog

Skills live in [`.claude/skills/`](../.claude/skills). Invoke with `/<name>` or let
Claude pick by task. Each encodes the workflow, real paths, security checks, and a
definition of done.

| Skill | Use when you are… |
|---|---|
| `aura-feature` | Implementing a feature end-to-end (vertical slice: UI + API + lib + DB + tests) |
| `aura-debug` | Diagnosing & fixing a bug with a regression test |
| `aura-code-review` | Reviewing a change as a senior engineer |
| `aura-test` | Building & running an appropriate test strategy |
| `aura-ai-agent` | Adding or modifying an AI employee (registry, tools, permissions, evals) |
| `aura-ai-integration` | Integrating a new model provider or AI capability |
| `aura-prompt-engineering` | Creating/improving an agent prompt with eval cases |
| `aura-security-audit` | Auditing app + AI security |
| `aura-database-change` | Changing the Prisma schema safely |
| `aura-api` | Adding/modifying an API endpoint |
| `aura-refactor` | Improving structure without changing behavior |
| `aura-performance` | Finding & fixing a measured bottleneck |
| `aura-documentation` | Keeping docs accurate |
| `aura-release` | Preparing a release |
| `aura-ai-evaluation` | Measuring whether agents actually improved |
| `aura-incident-response` | Investigating a production/workflow incident |
| `aura-context-optimizer` | Orienting efficiently in the codebase |
| `aura-autonomous-workflow` | Building a durable multi-agent workflow |

<a id="maintenance"></a>
## Maintenance — keep docs from going stale

Update the paired doc **in the same change** when you touch a contract:

| You changed… | Update… |
|---|---|
| An API route's request/response | [api-design.md](architecture/api-design.md) + the route's doc |
| `prisma/schema.prisma` | [database.md](architecture/database.md) |
| Agent tools / permissions | [agent-permissions.md](security/agent-permissions.md) + [tool-calling.md](ai-engineering/tool-calling.md) |
| An agent prompt | prompt version note + [evaluation-and-testing.md](ai-engineering/evaluation-and-testing.md) |
| An env var | [environment-variables.md](operations/environment-variables.md) + `.env.example` |
| Deployment / infra | [deployment.md](operations/deployment.md) |
| A security control | [threat-model.md](security/threat-model.md) + relevant security doc |

Run the doc validator before pushing docs:

```bash
node scripts/check-docs.mjs
```

It checks that required docs exist, internal links resolve, skills are well-formed,
and documented env vars match `.env.example`. See
[operations/commands.md](operations/commands.md#documentation-validation).
Run a periodic deep audit with the
[documentation-audit prompt](prompts/documentation-audit.md).

# AURA prompt library

Ready-to-use prompts for complex AURA workflows. Copy a prompt, fill the
`[PLACEHOLDERS]`, and paste it to Claude Code. Each prompt is written for AURA's
real modules and conventions.

**Prompt vs skill:** a *skill* (`.claude/skills/`) is invoked with `/<name>` and
loads a full workflow Claude follows. A *prompt* here is copy-paste text you can
tweak. Many prompts tell Claude to use the matching skill — use whichever fits.

## How each prompt is structured

- **When to use** · **What to provide** · **The prompt** (copy-paste) ·
  **Expected deliverables** · **Verification** · **Common failure modes**.

## Index

| Prompt | For |
|---|---|
| [feature-development](feature-development.md) | Vertical-slice feature |
| [debugging](debugging.md) | Reproduce → root-cause → fix → regression test |
| [architecture-planning](architecture-planning.md) | Compare options, recommend minimal change |
| [ai-agent-development](ai-agent-development.md) | Add a new AI employee |
| [improving-an-agent](improving-an-agent.md) | Diagnose & improve an existing agent |
| [ai-provider-integration](ai-provider-integration.md) | Add a model provider |
| [tool-integration](tool-integration.md) | Add an agent tool |
| [prompt-optimization](prompt-optimization.md) | Improve a prompt against evals |
| [context-engineering](context-engineering.md) | Reduce irrelevant context |
| [rag-and-retrieval](rag-and-retrieval.md) | Add/improve retrieval safely |
| [database-changes](database-changes.md) | Safe schema change |
| [api-development](api-development.md) | Secure, tested endpoint |
| [refactoring](refactoring.md) | Improve structure, preserve behavior |
| [security-audit](security-audit.md) | Prioritized, verifiable findings |
| [performance-audit](performance-audit.md) | Measure → fix → verify |
| [code-review](code-review.md) | Senior-engineer review |
| [testing](testing.md) | Risk-based test coverage |
| [integration-debugging](integration-debugging.md) | Cross-boundary failure tracing |
| [autonomous-workflow-development](autonomous-workflow-development.md) | Durable multi-agent workflow |
| [release-readiness](release-readiness.md) | Validate a release |
| [production-incident](production-incident.md) | Investigate & mitigate safely |
| [documentation-audit](documentation-audit.md) | Sync docs ↔ implementation |
| [full-repository-audit](full-repository-audit.md) | Inventory debt/risks → remediation plan |
| [session-handoff](session-handoff.md) | Summarize work for a fresh session |

## Golden rules baked into these prompts

- Inspect before changing; reuse the choke points (model/tool/auth/api/events).
- Scope by `companyId`; validate input and AI output; least-privilege tools.
- Flag fallbacks; don't fake success; **run** the tests you claim pass.
- On this machine: `AURA_DIST_DIR=/tmp/aura-next` for dev/build/e2e.

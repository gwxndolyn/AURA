# Product vision

## What AURA is

**AURA is an AI product engineering workspace.** You describe what you want to
build or fix; a team of specialised AI agents plans it, designs it, builds it in
a real repository, verifies it with real tests, iterates on failures and guides
you through a controlled release — while you stay in control of every
consequential step.

> **Give your AI engineering team a task. Watch it work. Review the evidence. Stay in control.**

The living office is AURA's personality: a small pixel-art studio where you can
see who is doing what. The engineering workflow is AURA's value. Both read the
same persisted state.

## Who it is for

Individual developers and small teams who want to delegate real engineering
work — bug fixes, features, tests, reviews — without giving up visibility or
control, and people who want to take an idea to a verified first release
without hand-coordinating every step.

## Problems it solves

- Coordinating several kinds of work (requirements, design, code, tests,
  review, release) is overhead; AURA sequences it with explicit dependencies.
- AI coding output is hard to trust; AURA treats model output as a proposal and
  only counts work as **verified** when tests ran in a sandbox and review
  evidence holds.
- Autonomy without control is reckless; AURA's autonomy levels and approval
  classes keep publication and production behind a person.

## Everyday use cases (what works today)

| Use case | Status |
|---|---|
| Idea → brief → backlog → design/architecture artifacts → reviewed scope | Works (template drafts without an API key, labelled) |
| Fix a bug / implement a scoped change with real tests, review and bounded repair | Works on codebases with a known test harness (sample apps) |
| Review a proposed change with evidence-backed findings | Works |
| Commit verified work to an isolated git branch; build a re-tested release candidate | Works (AURA-managed git) |
| Push + open a GitHub/GitLab pull request | Implemented; needs a repo-scoped token (untested live) |
| Deploy to production | Not available: no deployment provider is configured (honestly reported) |
| Bring an arbitrary existing repository and run its tests | Not yet: the sandbox has no network for dependency installation |

## Principles

1. **Evidence over claims.** A task is verified only by executed tests and
   evidence-backed review. "The agent said it's done" counts for nothing.
2. **Honest status everywhere.** Template, simulated-candidate, demo and
   not-run states are labelled; nothing is presented as more than it is.
3. **Authorization in code, not prompts.** Tool allowlists, write scopes,
   approvals, budgets and tenant isolation are enforced by the application.
4. **Bounded autonomy.** Retries, repairs, parallelism and spend are limited;
   persistent failure stops and asks for a person.
5. **Reuse, don't fork.** One mission engine, one agent registry, one event
   store; the product lifecycle composes them.
6. **The office is a view, never the source of truth.**

## AURA is / is not

| AURA is | AURA is not |
|---|---|
| A workspace that executes and verifies engineering work | A chatbot that only writes text |
| A coordinator of specialised agent roles | A claim of 13 independent AIs (roles share one provider; see [agent-orchestration.md](agent-orchestration.md)) |
| A controlled path to release | An auto-deployer to production |
| Playful in presentation | A game or company simulator |

The repository still contains AURA's earlier **company simulator** (sim clock,
cyber range, simulated deploy pipeline, company twin). These are labelled
demo/simulation surfaces and are not part of the product lifecycle.

## Live vs demo

- **Live:** product lifecycle, missions, sandbox tests, git, approvals — all
  persisted and real. Without an API key the PM/designer/architect drafts and
  the engineer's edits come from deterministic, labelled templates/candidates,
  while tests, probes and git remain real.
- **Demo:** the landing-page walkthrough and the demo workspace use fixtures
  and say so. See [demo-mode.md](demo-mode.md).

## Success criteria

- A first-time user takes an idea to a verified task and a release candidate
  without reading docs.
- Every "verified" claim links to a sandbox test run and a diff.
- No consequential external action happens without an explicit approval.
- Users can tell, on any screen, what is real, simulated or not run.

---
name: aura-context-optimizer
description: Work efficiently in AURA's large codebase — locate the exact entry point, read only the necessary dependencies, reuse conventions, and keep a concise list of verified findings. Use to orient quickly without reading unrelated files or sacrificing correctness.
---

# aura-context-optimizer

## When to use
Starting a task in an unfamiliar area; avoiding wasted exploration.

## Required context
`docs/architecture/repository-map.md`, `docs/architecture/overview.md`,
root `CLAUDE.md`.

## Workflow
1. State the **precise task** in one sentence.
2. Read the relevant architecture doc first (it points at real files).
3. Locate the **actual entry point** via the repository map (don't grep blind).
4. Trace **only** the necessary dependencies (route → the one `lib` fn → its prisma
   calls). Stop when you have enough.
5. Reuse existing conventions and choke points — don't reinvent.
6. Keep a short running list of **verified findings** (file:line facts), not whole
   files.
7. Summarize decisions and open questions.
8. Don't re-explore what you already established this task.

## Efficiency rules
- Prefer the docs + repository map over reading many files.
- Delegate broad multi-file searches to an `Explore` agent and keep only the
  conclusion.
- Never sacrifice correctness to reduce context — verify before acting.

## Definition of done
A concise, correct understanding of the entry point + the exact files that must
change, with verified findings.

## Final report
Entry point · the minimal set of files involved · verified findings · open
questions.

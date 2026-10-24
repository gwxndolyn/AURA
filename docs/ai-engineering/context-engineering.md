# Context engineering

Send an agent **only** what the task needs. Not the whole DB, repo, or history.

## How AURA keeps context small

`orchestrator.runAgent` builds a focused prompt:

- A **compact company snapshot** (one block of key metrics), not the full company
  record or history.
- **Retrieved memory** via `retrieveContext(agentId, objective)` — top 5 long-term
  by relevance + up to 4 keyword-scored short-term bullets, not every memory.
- **Inline task context** only (description, acceptance criteria).
- The **objective**.

Short memory is pruned to 20 most recent (`remember`). This bounds the prompt and
cost regardless of how long a company has run.

## Guidelines

1. **Budget tokens deliberately.** More context ≠ better output; it's slower,
   costlier, and dilutes attention. Start minimal, add only what demonstrably helps.
2. **Retrieve, don't dump.** Select relevant rows/bullets by the objective. If you
   need more memory signal, improve retrieval scoring — don't widen the window.
3. **Summarize history** instead of replaying it. `safeSummary` stores a short line
   per turn; feed summaries forward, not transcripts.
4. **Freshness** — read current state at turn time (the snapshot is built fresh);
   don't cache stale company metrics into a prompt.
5. **Separate trust levels** — keep untrusted content (task text, retrieved docs,
   tool output) in clearly-labeled context sections, distinct from the system
   prompt. See [prompt-injection-defense](prompt-injection-defense.md).
6. **Truncate tool/large outputs** before feeding them back (the tool runner stores
   at most 4000 chars; apply a similar cap to what you re-inject).

## When you need more retrieval

If a task genuinely needs document retrieval (RAG), add it behind the same
discipline: relevance scoring, access control (scope to the company), source
tracking, and treat retrieved text as untrusted. Use the RAG prompt in the library
and the `aura-ai-agent` skill. Don't bolt a vector dump onto the prompt.

## Checklist for a new agent/turn

- [ ] Only the needed context sections are included.
- [ ] Memory is retrieved (scored), not dumped.
- [ ] Large/tool outputs are truncated.
- [ ] Untrusted content is labeled and separate from system instructions.
- [ ] State is read fresh at turn time.

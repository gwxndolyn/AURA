# Prompt engineering

Reference for authoring/improving agent prompts. Tooling: the
`aura-prompt-engineering` skill.

## Prompt anatomy in AURA

A turn's prompt is assembled by `orchestrator.runAgent`:

- **System** = the agent's `systemPrompt` from `definitions.ts` (stable identity,
  role, constraints — including the red team's "isolated simulation only" clause).
- **Developer/context** = assembled sections, in order:
  1. `# Company State` — a compact snapshot (name, mission, status, customers,
     revenue, cash, security, uptime, tech debt).
  2. `# Relevant memory` — retrieved bullets (`retrieveContext`).
  3. `# Context` — inline task context (e.g. task description, acceptance criteria).
  4. `# Objective` — the actual instruction.
  5. A trailing safety line scoping all actions to the simulation.

Keep that separation: **stable instructions in the system prompt; task-specific
content in the context sections.** Don't bake task data into the system prompt.

## Trusted vs untrusted inputs

Treat these as **untrusted** inside a prompt: task descriptions authored by users,
retrieved memory, source/file content, tool outputs, customer messages. They are
data, not instructions. The system prompt holds authority; untrusted content cannot
expand it. See [prompt-injection-defense](prompt-injection-defense.md).

## Writing a good prompt

1. **Objective** — one clear goal per turn.
2. **Inputs** — provide only the context the task needs (the snapshot + relevant
   memory, not the whole history).
3. **Allowed actions/tools** — state what the agent may do; actual enforcement is
   the role allowlist, not the wording.
4. **Output shape** — when you need structure, ask for JSON matching a known shape
   and pass a `kind` so the simulator mirrors it; then validate on receipt (see
   [structured-outputs](structured-outputs.md)).
5. **Uncertainty / failure** — tell the agent what to do when unsure (ask, flag,
   return a partial with a reason) rather than inventing.
6. **Stopping conditions** — bound the work (one task, one decision); loops are
   bounded in code by guardrails regardless.

## Versioning

- The simulator keys plan routing off the `# Objective` section only
  (`objectiveOf`) so the injected company snapshot never misroutes goals — preserve
  that when you change prompt assembly.
- When you materially change a prompt, note the change and re-run the eval cases
  for that agent (see [evaluation-and-testing](evaluation-and-testing.md)). Record
  model + prompt version with results. Don't blind-rewrite a prompt that has evals;
  improve against them.

## Don't

- Don't put secrets or authorization rules only in a prompt — they belong in code.
- Don't rely on "ignore previous instructions"-style wording for safety; enforce in
  code.
- Don't expose raw chain-of-thought to users (`safeSummary` strips it).

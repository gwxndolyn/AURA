# Sandbox architecture

Agent-generated code is **never** run in the app process. It runs in a locked-down
Docker container, or — if Docker is absent — a clearly-flagged simulated result is
used so the app still works. Code: `src/lib/sandbox/`.

## Pieces

| File | Role |
|---|---|
| `docker.ts` | `createWorkspace`, `execInSandbox`, `dockerAvailable` — the container runner. |
| `runner.ts` | `runNodeTests`, `runSyntaxCheck` — run real `node --test` / `node --check` in the sandbox. |
| `codegen.ts` | `generateFeature(title, description)` — picks a runnable template by keyword (auth, validation, money, ratelimit, authz, generic), each with a real test suite. |

## Isolation (from `docker.ts`)

Each exec runs `docker run --rm` with:

- `--network none` (or `bridge` only if explicitly requested) — no network.
- `--memory` / `--memory-swap` (`AURA_SANDBOX_MEMORY`, default `256m`), `--cpus`
  (default `1`) — resource caps.
- `--pids-limit=256` — fork-bomb protection.
- `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `-u node` (non-root).
- Workspace mounted at `/work`; `--tmpfs /tmp` for scratch; nothing else writable.
- Host wall-clock timeout (`AURA_SANDBOX_TIMEOUT_MS`, default 20000) + 5s teardown.
- Captured output capped at 64 KiB.

Workspace writes are path-sanitized (`sanitizeRel`) to prevent traversal /
absolute paths escaping `/work`.

## The quality gate (`workflows/executeTask.ts`)

For coding tasks (`frontend-engineer`/`backend-engineer`):

1. Agent turn produces narrative + `generateFeature` produces **real** module +
   test code, persisted to the `CodeWorkspace`.
2. `runSyntaxCheck` → real `node --check` in the sandbox.
3. `runNodeTests` → real `node --test` in the sandbox during QA.
4. The task reaches **DONE only if `realTest.mode === "docker"` and tests pass**
   and acceptance criteria are met; otherwise it goes to REVIEW.

If Docker is unavailable, `realTest.mode !== "docker"`, so the QA agent's simulated
result is used and the event is flagged `real: false`. A passing result is only
ever reported as "real sandbox" when it actually ran in Docker.

Check which mode is live: `GET /api/ai/status` → `sandbox: "docker" | "simulated"`,
or `GET /api/health` → `checks.sandbox`. The Code page shows a badge.

## Security notes

- The sandbox is for **untrusted generated code**, not for the cyber range (which
  is a separate in-process *simulation* of attacks against toy targets — it does
  not execute real exploits).
- Never relax the container flags to make a template "work" — fix the template.
- See [../security/sandbox-security.md](../security/sandbox-security.md).

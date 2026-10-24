# Sandbox security

The Docker sandbox runs **untrusted, agent-generated code**. Treat the code as
hostile; the container is the containment boundary. Implementation:
[../architecture/sandbox-architecture.md](../architecture/sandbox-architecture.md).

## Guarantees (from `src/lib/sandbox/docker.ts`)

Every `execInSandbox` runs `docker run --rm` with:

- `--network none` by default (no egress; `bridge` only if a caller explicitly
  opts in — avoid).
- `--memory` / `--memory-swap` + `--cpus` — resource caps.
- `--pids-limit=256` — fork-bomb protection.
- `--cap-drop=ALL` + `--security-opt=no-new-privileges` + `-u node` — non-root, no
  capabilities, no privilege escalation.
- Workspace mounted at `/work`; `--tmpfs /tmp` scratch; **nothing else writable**.
- Host wall-clock timeout (default 20s) + 5s teardown; output capped at 64 KiB.

Workspace writes go through `sanitizeRel` — normalizes and rejects absolute paths
or `..` traversal, so writes can't escape `/work`.

## Rules

- **Never weaken the flags** to make a template "work". If a template needs the
  network, redesign it to not need the network — don't add `--network bridge`.
- **No secrets in the sandbox.** It has no network and no secret mounts; keep it
  that way. Generated code must never receive the API key or env secrets.
- **Don't run untrusted code outside the sandbox.** The app process never evals
  generated code; the quality gate (`executeTask`) only trusts a result when
  `realTest.mode === "docker"`.
- **Fail closed.** If Docker is unavailable, the gate uses a *flagged simulated*
  result (`real: false`) — it does not pretend the code passed real tests.
- **Validate the fallback can't be gamed.** A passing status is only reported as
  "real sandbox" when it actually ran in Docker.

## Checking mode

`GET /api/ai/status` → `sandbox: "docker" | "simulated"`; `GET /api/health` →
`checks.sandbox`. The Code page shows a badge.

## If you extend the sandbox

- Keep the isolation flags; add new limits rather than removing any.
- New file writes must go through the sanitized workspace API.
- Add a test to `runner.test.ts` (it already proves real pass/fail detection and
  that a syntax error fails the build). Guard on `dockerAvailable()`.

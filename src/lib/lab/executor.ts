/**
 * Command execution for the engineering lab.
 *
 *   docker        the same locked-down sandbox the builder uses
 *                 (src/lib/sandbox/docker.ts: no network, non-root, limits)
 *   host-trusted  runs on the AURA server host, with a minimal environment
 *                 (PATH + HOME only, no secrets), a timeout and a disposable
 *                 directory. ONLY for AURA's own bundled benchmark fixtures
 *                 (src/lib/lab/benchmarks.ts), which are reviewed source in
 *                 this repository. It never runs customer, agent-generated or
 *                 downloaded code — benchmark files are copied from the suite,
 *                 never from a request — and it is disabled unless
 *                 AURA_LAB_HOST_EXECUTION=1 (tests and local development).
 *
 * Every run records which executor it used; results are never mixed across
 * executors in a comparison.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, normalize } from "node:path";
import { dockerAvailable, createWorkspace, execInSandbox } from "@/lib/sandbox/docker";

export type ExecutorKind = "docker" | "host-trusted";
export interface ExecOutcome { command: string; exitCode: number | null; output: string; durationMs: number; timedOut: boolean }

const ALLOWED = /^(npm test( --silent)?|node --test( [A-Za-z0-9_./-]+)*)$/;

export async function chooseExecutor(): Promise<{ kind: ExecutorKind | null; reason: string }> {
  if (await dockerAvailable()) return { kind: "docker", reason: "Docker sandbox available" };
  if (process.env.AURA_LAB_HOST_EXECUTION === "1") return { kind: "host-trusted", reason: "Docker unavailable; host execution of bundled fixtures enabled (AURA_LAB_HOST_EXECUTION=1)" };
  return { kind: null, reason: "Docker sandbox unavailable and host execution of fixtures is disabled" };
}

function safeRel(p: string) {
  const n = normalize(p).replace(/^\/+/, "");
  if (n.startsWith("..") || n.includes("/../") || n.split("/").includes(".git")) throw new Error(`unsafe fixture path ${p}`);
  return n;
}

export async function runInFixture(kind: ExecutorKind, files: Record<string, string>, command: string, timeoutMs = 60_000): Promise<ExecOutcome> {
  if (!ALLOWED.test(command)) throw new Error(`lab command not allowed: ${command}`);
  const started = Date.now();
  if (kind === "docker") {
    const ws = await createWorkspace(files);
    try {
      const r = await execInSandbox(ws, `export HOME=/tmp CI=1; ${command}`, { timeoutMs });
      if (r.mode !== "docker") throw new Error("sandbox became unavailable");
      return { command, exitCode: r.exitCode, output: (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).slice(-16_000), durationMs: r.durationMs, timedOut: r.timedOut };
    } finally {
      await ws.cleanup();
    }
  }
  if (process.env.AURA_LAB_HOST_EXECUTION !== "1") throw new Error("host execution is disabled");
  const dir = await mkdtemp(join(tmpdir(), "aura-lab-"));
  try {
    for (const [p, c] of Object.entries(files)) {
      const abs = join(dir, safeRel(p));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, c, "utf8");
    }
    const [bin, ...args] = command.split(" ");
    const r = await new Promise<{ code: number | null; out: string; timedOut: boolean }>((resolve) => {
      const child = execFile(bin, args, { cwd: dir, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, CI: "1", npm_config_update_notifier: "false" } as unknown as NodeJS.ProcessEnv, encoding: "utf8" }, (err: Error | null, stdout: string, stderr: string) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${stdout}${stderr ? `\n${stderr}` : ""}`, timedOut: !!e?.killed });
      });
      child.stdin?.end();
    });
    return { command, exitCode: r.code, output: r.out.slice(-16_000), durationMs: Date.now() - started, timedOut: r.timedOut };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

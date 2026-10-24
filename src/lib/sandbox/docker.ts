import { spawn } from "child_process";
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

/**
 * Real isolated execution sandbox backed by Docker.
 *
 * Agent-generated code is written to an ephemeral host workspace directory,
 * which is mounted read-write into a locked-down `node:20-alpine` container:
 *   --network none      no network access
 *   --memory / --cpus   resource limits
 *   --pids-limit        fork-bomb protection
 *   --cap-drop ALL      no Linux capabilities
 *   --read-only root    only /work (the mount) and tmpfs are writable
 *   -u node             non-root user
 * plus a hard wall-clock timeout enforced on the host.
 *
 * If Docker is unavailable, callers fall back to the in-process simulator so the
 * app still works everywhere. `dockerAvailable()` reports which mode is active.
 */

const IMAGE = process.env.AURA_SANDBOX_IMAGE || "node:20-alpine";
const MEM = process.env.AURA_SANDBOX_MEMORY || "256m";
const CPUS = process.env.AURA_SANDBOX_CPUS || "1";
const TIMEOUT_MS = Number(process.env.AURA_SANDBOX_TIMEOUT_MS || 20000);
const MAX_OUTPUT = 64 * 1024; // cap captured output

export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  mode: "docker" | "unavailable";
}

let dockerOk: boolean | null = null;

/** Cached check: is a working Docker daemon reachable? */
export async function dockerAvailable(): Promise<boolean> {
  if (dockerOk !== null) return dockerOk;
  try {
    // The daemon answering is not enough: the sandbox image must be present and readable.
    const r = await runHost("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], 8000);
    dockerOk = r.exitCode === 0;
  } catch {
    dockerOk = false;
  }
  return dockerOk;
}

/** Run a host command (used for docker itself), with a timeout. */
function runHost(
  cmd: string,
  args: string[],
  timeoutMs: number,
  opts?: { cwd?: string },
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts?.cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + String(e), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

export interface Workspace {
  dir: string;
  write(files: Record<string, string>): Promise<void>;
  read(file: string): Promise<string | null>;
  list(): Promise<string[]>;
  cleanup(): Promise<void>;
}

/** Create an ephemeral host workspace directory. */
export async function createWorkspace(seedFiles?: Record<string, string>): Promise<Workspace> {
  const dir = await mkdtemp(path.join(tmpdir(), "aura-ws-"));

  const ws: Workspace = {
    dir,
    async write(files) {
      for (const [rel, content] of Object.entries(files)) {
        const safe = sanitizeRel(rel);
        const full = path.join(dir, safe);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, content, "utf8");
      }
    },
    async read(file) {
      try {
        return await readFile(path.join(dir, sanitizeRel(file)), "utf8");
      } catch {
        return null;
      }
    },
    async list() {
      return walk(dir, dir);
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };

  if (seedFiles) await ws.write(seedFiles);
  return ws;
}

/** Prevent path traversal / absolute paths escaping the workspace. */
function sanitizeRel(rel: string): string {
  const norm = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  if (path.isAbsolute(norm) || norm.startsWith("..")) {
    throw new Error(`Illegal path outside workspace: ${rel}`);
  }
  return norm;
}

async function walk(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(root, full)));
    else out.push(path.relative(root, full));
  }
  return out;
}

/**
 * Execute a shell command inside the sandbox container against a workspace.
 * The command runs as `sh -c "<command>"` with the workspace mounted at /work.
 */
export async function execInSandbox(
  ws: Workspace,
  command: string,
  opts?: { timeoutMs?: number; network?: boolean; name?: string; tmpfsMb?: number },
): Promise<ExecResult> {
  const start = Date.now();
  if (!(await dockerAvailable())) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "Docker sandbox unavailable",
      durationMs: 0,
      timedOut: false,
      mode: "unavailable",
    };
  }

  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  const mem = opts?.network ? (process.env.AURA_SANDBOX_INSTALL_MEMORY || "1g") : MEM;
  const args = [
    "run",
    "--rm",
    "-i",
    // A caller-chosen name lets the run be cancelled with `docker kill` (killSandbox).
    ...(opts?.name ? ["--name", opts.name] : []),
    opts?.network ? "--network=bridge" : "--network=none",
    `--memory=${mem}`,
    `--memory-swap=${mem}`,
    `--cpus=${CPUS}`,
    "--pids-limit=256",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "-u",
    "node",
    "-w",
    "/work",
    "-v",
    `${ws.dir}:/work`,
    // tmpfs for anything the toolchain needs to write outside /work
    "--read-only",
    "--tmpfs",
    `/tmp:rw,exec,size=${Math.min(Math.max(opts?.tmpfsMb ?? 64, 16), 1024)}m`,
    IMAGE,
    "sh",
    "-c",
    command,
  ];

  // Give docker a little extra wall-clock over the inner timeout for teardown.
  const r = await runHost("docker", args, timeoutMs + 5000);
  // A timed-out `docker run` client was killed; make sure the container is gone too.
  if (r.timedOut && opts?.name) await runHost("docker", ["rm", "-f", opts.name], 10_000).catch(() => null);
  // exit 125 / daemon error = the container never started: report the sandbox as unavailable, never as a command result.
  if (!r.timedOut && (r.exitCode === 125 || /^docker: Error response from daemon|Cannot connect to the Docker daemon/m.test(r.stderr))) {
    dockerOk = null; // re-probe next time
    return { ok: false, exitCode: null, stdout: "", stderr: `Docker sandbox failed to start a container: ${r.stderr.slice(0, 500)}`, durationMs: Date.now() - start, timedOut: false, mode: "unavailable" };
  }
  return {
    ok: r.exitCode === 0 && !r.timedOut,
    exitCode: r.exitCode,
    stdout: r.stdout.slice(0, MAX_OUTPUT),
    stderr: r.stderr.slice(0, MAX_OUTPUT),
    durationMs: Date.now() - start,
    timedOut: r.timedOut,
    mode: "docker",
  };
}


/** Stop a named sandbox container (cancellation). Only names created by AURA are accepted. */
export async function killSandbox(name: string): Promise<boolean> {
  if (!/^aura-[a-z0-9-]{6,64}$/.test(name)) throw new Error("Refusing to kill a container AURA did not name");
  const r = await runHost("docker", ["kill", name], 10_000);
  return r.exitCode === 0;
}

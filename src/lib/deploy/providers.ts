/**
 * Deployment providers behind one interface. A provider must:
 *   verify()   prove the credentials/daemon work (connection status is never assumed)
 *   deploy()   build + start the given source; return provider-issued identifiers + URL
 *   stop()     stop a deployment (used for rollback / superseding)
 *   logs()     return provider logs for a deployment
 *
 * Implemented: `docker-host` — runs generated Node web apps as containers on a
 * Docker daemon AURA can reach (local, or remote via DOCKER_HOST/TLS). The
 * image is built FROM the exact release commit's files (no host paths, no
 * secrets in layers); the container runs non-root, read-only root FS, no new
 * privileges, memory/CPU/pids limits, a writable /tmp + /data volume only.
 * It is a real deployment: the app is served on the configured host/port,
 * and "deployed" is only recorded after AURA's own HTTP health checks pass.
 *
 * Not implemented (no credentials here to test against): managed platforms
 * (Fly.io, Render, Vercel…). Add them by implementing DeployProvider; the
 * release flow, approvals, health checks and rollback do not change.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { normalizePath } from "@/lib/devspace/paths";

const run = promisify(execFile);

export interface DeployRequest { deploymentId: string; productId: string; env: string; files: Record<string, string>; config: TargetConfig; secretEnv: Record<string, string>; log: (line: string) => Promise<void> | void }
export interface DeployResult { providerRef: Record<string, string>; url: string }
export interface TargetConfig { port?: number; bindAddress?: string; publicHost?: string; healthPath?: string; journeys?: { path: string; expectStatus?: number; expectText?: string }[]; env?: Record<string, string>; memory?: string; cpus?: string; baseImage?: string }

export interface DeployProvider {
  id: string;
  label: string;
  supportsRollback: boolean;
  verify(cfg: TargetConfig): Promise<{ ok: boolean; detail: string }>;
  deploy(req: DeployRequest): Promise<DeployResult>;
  stop(providerRef: Record<string, string>): Promise<void>;
  /** Stop every running instance of a product environment (whatever is actually live, per the provider). */
  stopEnv(productId: string, env: string): Promise<string[]>;
  logs(providerRef: Record<string, string>, tail?: number): Promise<string>;
}

export class DeployError extends Error {
  constructor(message: string, public stage: string, public retryable = false) {
    super(message);
    this.name = "DeployError";
  }
}

const SAFE = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
const docker = async (args: string[], opts: { timeout?: number; input?: string } = {}) => {
  try {
    const { stdout, stderr } = await run("docker", args, { timeout: opts.timeout ?? 120_000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? err.message}` };
  }
};

/** Build with BuildKit streaming output into the deployment log. */
function dockerBuild(ctxDir: string, tag: string, log: (l: string) => void | Promise<void>, timeoutMs: number) {
  return new Promise<{ ok: boolean; out: string }>((resolve) => {
    const p = spawn("docker", ["build", "--pull=false", "-t", tag, ctxDir], { env: { ...process.env, DOCKER_BUILDKIT: "1", BUILDKIT_PROGRESS: "plain" } });
    let out = "";
    const onData = (b: Buffer) => { const s = b.toString(); out += s; for (const l of s.split("\n").filter(Boolean).slice(-5)) void log(`[build] ${l.slice(0, 300)}`); };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code) => { clearTimeout(t); resolve({ ok: code === 0, out: out.slice(-20_000) }); });
    p.on("error", (e) => { clearTimeout(t); resolve({ ok: false, out: String(e) }); });
  });
}

export function dockerfileFor(files: Record<string, string>, cfg: TargetConfig) {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string> } = {};
  try { pkg = JSON.parse(files["package.json"] ?? "{}"); } catch { /* validated by preflight */ }
  const hasDeps = Object.keys(pkg.dependencies ?? {}).length > 0;
  const lock = files["package-lock.json"] !== undefined;
  const port = cfg.port ?? 3000;
  return [
    `FROM ${cfg.baseImage || "node:20-alpine"}`,
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    `ENV PORT=${port}`,
    "COPY . .",
    ...(hasDeps ? [lock ? "RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund" : "RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund"] : []),
    "RUN mkdir -p /data && chown -R node:node /data",
    "USER node",
    "ENV DATA_DIR=/data",
    `EXPOSE ${port}`,
    `CMD ${JSON.stringify(pkg.scripts?.start ? ["npm", "start", "--silent"] : ["node", "src/server.js"])}`,
  ].join("\n") + "\n";
}

export const dockerHost: DeployProvider = {
  id: "docker-host",
  label: "Docker host (container on a Docker daemon AURA can reach)",
  supportsRollback: true,
  async verify() {
    const v = await docker(["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
    if (!v.ok) return { ok: false, detail: `Docker daemon not reachable: ${v.out.trim().slice(0, 200)}` };
    return { ok: true, detail: `Docker Engine ${v.out.trim()}${process.env.DOCKER_HOST ? ` at ${process.env.DOCKER_HOST}` : " (local socket)"}` };
  },
  async deploy(req) {
    const port = req.config.port ?? 3000;
    const host = req.config.bindAddress ?? "127.0.0.1";
    const name = `aura-app-${SAFE(req.productId).slice(-12)}-${req.env}-${SAFE(req.deploymentId).slice(-8)}`;
    const tag = `aura-app/${SAFE(req.productId)}:${SAFE(req.deploymentId)}`;
    const dir = await mkdtemp(join(tmpdir(), "aura-deploy-"));
    try {
      for (const [raw, c] of Object.entries(req.files)) {
        const p = normalizePath(raw);
        if (p.split("/").some((s) => s === ".git" || s === "node_modules" || s === ".env")) continue;
        await mkdir(dirname(join(dir, p)), { recursive: true });
        await writeFile(join(dir, p), c, "utf8");
      }
      await writeFile(join(dir, "Dockerfile"), dockerfileFor(req.files, req.config));
      await writeFile(join(dir, ".dockerignore"), "node_modules\n.git\n.env\n.env.*\ndata\n");
      await req.log(`building image ${tag}`);
      const b = await dockerBuild(dir, tag, req.log, Number(process.env.AURA_DEPLOY_BUILD_TIMEOUT_MS || 600_000));
      if (!b.ok) throw new DeployError(`Image build failed:\n${b.out.slice(-3000)}`, "build");
      await req.log(`starting container ${name} on ${host}:${port}`);
      const envArgs = Object.entries({ ...(req.config.env ?? {}), ...req.secretEnv }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const r = await docker(["run", "-d", "--name", name, "--restart", "unless-stopped", "-p", `${host}:${port}:${port}`, "--read-only", "--tmpfs", "/tmp:rw,size=64m", "-v", `${name}-data:/data`, `--memory=${req.config.memory ?? "256m"}`, `--cpus=${req.config.cpus ?? "1"}`, "--pids-limit=256", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--label", `aura.product=${req.productId}`, "--label", `aura.deployment=${req.deploymentId}`, "--label", `aura.env=${req.env}`, ...envArgs, tag], { timeout: 60_000 });
      if (!r.ok) throw new DeployError(`Container failed to start: ${r.out.trim().slice(0, 1000)}`, "start");
      const container = r.out.trim().split("\n").pop()!;
      const url = `http://${req.config.publicHost ?? (host === "0.0.0.0" ? "localhost" : host)}:${port}`;
      return { providerRef: { image: tag, container, name }, url };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  async stop(ref) {
    if (ref.name) await docker(["rm", "-f", ref.name], { timeout: 30_000 });
  },
  async stopEnv(productId, env) {
    const ls = await docker(["ps", "-aq", "--filter", `label=aura.product=${productId}`, "--filter", `label=aura.env=${env}`], { timeout: 15_000 });
    const ids = ls.ok ? ls.out.split("\n").map((x) => x.trim()).filter((x) => /^[0-9a-f]{12,}$/.test(x)) : [];
    if (ids.length) await docker(["rm", "-f", ...ids], { timeout: 30_000 });
    return ids;
  },
  async logs(ref, tail = 200) {
    if (!ref.name) return "";
    return (await docker(["logs", "--tail", String(tail), ref.name], { timeout: 15_000 })).out.slice(-20_000);
  },
};

export const PROVIDERS: Record<string, DeployProvider> = { [dockerHost.id]: dockerHost };
export function providerOf(id: string) {
  const p = PROVIDERS[id];
  if (!p) throw new DeployError(`Unknown deployment provider ${id}`, "config");
  return p;
}

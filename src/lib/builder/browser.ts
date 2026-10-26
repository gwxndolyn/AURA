/**
 * Browser verification of a generated web app (AURA V10).
 *
 * Isolation: the app's code is untrusted, so it runs in a Docker container on
 * a per-run `--internal` network (no route to the internet or the host), with
 * the sandbox's limits (read-only root, cap-drop ALL, non-root, memory/pids
 * caps). A second locked-down relay container — AURA's own fixed code, not
 * the app's — is attached to that network and publishes ONE port on
 * 127.0.0.1 so the host's real Chromium (Playwright) can reach the app. The
 * relay forwards TCP to the app only.
 *
 * What it checks, per route and viewport (desktop 1280×800, mobile 390×844):
 *   - page loads (HTTP < 400), no uncaught page errors, no console errors,
 *     no failed same-origin requests (status ≥ 400 or network failure)
 *   - no horizontal overflow (document wider than the viewport)
 *   - interactive controls have accessible names; inputs have labels
 *   - visible buttons are not dead (a button outside a form with no
 *     handler-bearing attributes is reported as possibly inert — warning)
 *   - a screenshot of every route × viewport (stored as evidence)
 * and, when the product exposes a JSON collection API, a persistence journey:
 *   submit the page's first form with valid sample input → reload → the new
 *   record is visible. A journey that cannot be attempted is reported as
 *   "not_run" with the reason — never as passed.
 *
 * Every result is a recorded observation. If Docker or Chromium is not
 * available, verification returns status "unavailable" with the reason; the
 * engine reports the limitation and never treats it as a pass.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { log } from "@/lib/observability/log";

const run = promisify(execFile);
const IMAGE = process.env.AURA_SANDBOX_IMAGE || "node:20-alpine";

export interface BrowserFinding { kind: "load_failed" | "page_error" | "console_error" | "request_failed" | "overflow" | "unlabeled_control" | "inert_button" | "journey_failed"; route: string; viewport: string; detail: string; severity: "low" | "medium" | "high"; blocking: boolean }
export interface BrowserResult {
  status: "passed" | "failed" | "unavailable";
  reason?: string;
  routes: { route: string; viewport: string; httpStatus: number | null; screenshot: string | null; ms: number; requests?: { method: string; path: string; status: number }[] }[];
  findings: BrowserFinding[];
  journeys: { name: string; status: "passed" | "failed" | "not_run"; detail: string }[];
  durationMs: number;
}

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

async function docker(args: string[], timeoutMs = 60_000) {
  try {
    const { stdout, stderr } = await run("docker", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    // `docker logs` replays the container's stderr on stderr: keep both for diagnostics.
    return { ok: true, out: args[0] === "logs" ? `${stdout}${stderr}`.trim() : stdout.trim() };
  } catch (e) {
    return { ok: false, out: ((e as { stderr?: string }).stderr || (e as Error).message).slice(0, 800) };
  }
}

async function loadChromium(): Promise<null | { launch: (o?: object) => Promise<any> }> {
  if (process.env.AURA_BROWSER_VERIFY === "0") return null;
  try {
    // Optional runtime dependency (installed as a devDependency for e2e). Resolved at runtime only.
    const mod = await import(/* webpackIgnore: true */ "playwright-core" as string);
    return (mod as { chromium: { launch: (o?: object) => Promise<any> } }).chromium;
  } catch {
    return null;
  }
}

export async function browserAvailable() {
  const chromium = await loadChromium();
  if (!chromium) return { ok: false, reason: "Browser automation (playwright-core + Chromium) is not installed on this server" };
  const d = await docker(["version", "--format", "{{.Server.Version}}"], 10_000);
  if (!d.ok) return { ok: false, reason: "Docker is not available to run the app for browser verification" };
  return { ok: true, reason: "" };
}

/** Pages to visit: "/" plus static HTML pages, capped. */
export function routesFrom(files: string[]) {
  const pages = files.filter((f) => /^public\/[^/]+\.html$/.test(f) && f !== "public/index.html").map((f) => `/${f.slice("public/".length)}`);
  return ["/", ...pages].slice(0, 5);
}

/** Collection endpoints the app exposes (GET /api/<name>), from the static code index. */
export function collectionRoutes(routes: { method: string; path: string }[]) {
  const gets = new Set(routes.filter((r) => r.method === "GET").map((r) => r.path));
  return routes.filter((r) => r.method === "POST" && /^\/api\/[a-z0-9-]+$/.test(r.path) && gets.has(r.path)).map((r) => r.path);
}

const RELAY = `const net=require("net");net.createServer(c=>{const u=net.connect(3000,"app");c.pipe(u).pipe(c);u.on("error",()=>c.destroy());c.on("error",()=>u.destroy())}).listen(8080)`;

export type RunningApp = { base: string; stop: () => Promise<void> };

/**
 * Run an untrusted app tree in the isolated container + relay described above
 * and wait until it answers. Returns `{ app }` or `{ unavailable }` (infra
 * missing) or `{ failed, log }` (the app itself did not start). Shared by
 * build verification and the experience audit (src/lib/experience).
 */
export async function startIsolatedApp(args: { treeDir: string; id: string; startTimeoutMs?: number }): Promise<{ app: RunningApp } | { unavailable: string } | { failed: string; log: string; stop: () => Promise<void> }> {
  const id = `${args.id.slice(-10).toLowerCase().replace(/[^a-z0-9]/g, "")}-${randomBytes(3).toString("hex")}`;
  const net = `aura-bnet-${id}`;
  const app = `aura-bapp-${id}`;
  const relay = `aura-brel-${id}`;
  const port = 24000 + Math.floor(Math.random() * 8000);
  const lock = ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "-u", "node"];
  const stop = async () => {
    await docker(["rm", "-f", app, relay], 20_000);
    await docker(["network", "rm", net], 20_000);
  };
  const n = await docker(["network", "create", "--internal", net]);
  if (!n.ok) return { unavailable: `Could not create an isolated network: ${n.out}` };
  // No --rm: a crashed app's log must remain readable for the diagnosis (removed in stop()).
  const a = await docker(["run", "-d", "--name", app, "--network", net, "--network-alias", "app", ...lock, "--memory=256m", "--cpus=1", "--tmpfs", "/tmp:rw,size=64m", "-e", "PORT=3000", "-e", "DATA_DIR=/tmp/data", "-e", "NODE_ENV=production", "-v", `${args.treeDir}:/work:ro`, "-w", "/work", IMAGE, "node", "src/server.js"]);
  if (!a.ok) { await stop(); return { unavailable: `The app container did not start: ${a.out}` }; }
  const r = await docker(["run", "-d", "--rm", "--name", relay, ...lock, "--memory=64m", "-p", `127.0.0.1:${port}:8080`, IMAGE, "node", "-e", RELAY]);
  if (!r.ok) { await stop(); return { unavailable: `The relay did not start: ${r.out}` }; }
  await docker(["network", "connect", net, relay]);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (args.startTimeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return { app: { base, stop } };
    } catch {
      /* not ready */
    }
    await new Promise((x) => setTimeout(x, 400));
  }
  const logs = await docker(["logs", "--tail", "40", app]);
  return { failed: `The app did not start serving within ${Math.round((args.startTimeoutMs ?? 20_000) / 1000)} s.`, log: logs.out.slice(-1500), stop };
}

/** Real Chromium (Playwright), or null with the reason. */
export async function launchChromium(): Promise<{ browser: { close: () => Promise<void>; newContext: (o: object) => Promise<any> } } | { unavailable: string }> {
  const chromium = await loadChromium();
  if (!chromium) return { unavailable: "Browser automation (playwright-core + Chromium) is not installed on this server" };
  try {
    return { browser: await chromium.launch({ headless: true }) };
  } catch (e) {
    return { unavailable: `Chromium could not be launched: ${(e as Error).message.slice(0, 200)}` };
  }
}

export async function verifyInBrowser(args: { treeDir: string; buildId: string; files: string[]; apiRoutes: { method: string; path: string }[]; evidenceDir: string; startTimeoutMs?: number }): Promise<BrowserResult> {
  const t0 = Date.now();
  const empty = (status: BrowserResult["status"], reason: string): BrowserResult => ({ status, reason, routes: [], findings: [], journeys: [], durationMs: Date.now() - t0 });
  const chromium = await loadChromium();
  if (!chromium) return empty("unavailable", "Browser automation (playwright-core + Chromium) is not installed on this server");
  if (!args.files.includes("src/server.js") && !args.files.includes("package.json")) return empty("unavailable", "No runnable web entry point detected (expected package.json start script)");

  const findings: BrowserFinding[] = [];
  const routesOut: BrowserResult["routes"] = [];
  const journeys: BrowserResult["journeys"] = [];
  let browser: { close: () => Promise<void>; newContext: (o: object) => Promise<any> } | null = null;
  let stopApp: (() => Promise<void>) | null = null;
  try {
    const started = await startIsolatedApp({ treeDir: args.treeDir, id: args.buildId, startTimeoutMs: args.startTimeoutMs });
    if ("unavailable" in started) return empty("unavailable", started.unavailable);
    if ("failed" in started) {
      stopApp = started.stop;
      findings.push({ kind: "load_failed", route: "/", viewport: "-", detail: `${started.failed} Container log:\n${started.log}`, severity: "high", blocking: true });
      return { status: "failed", routes: [], findings, journeys: [{ name: "app starts", status: "failed", detail: "no HTTP response" }], durationMs: Date.now() - t0 };
    }
    stopApp = started.app.stop;
    const base = started.app.base;

    browser = await chromium.launch({ headless: true });
    await mkdir(args.evidenceDir, { recursive: true });
    for (const vp of VIEWPORTS) {
      const ctx = await browser!.newContext({ viewport: { width: vp.width, height: vp.height } });
      for (const route of routesFrom(args.files)) {
        const page = await ctx.newPage();
        const errors: string[] = [];
        const consoleErrors: string[] = [];
        const failed: string[] = [];
        page.on("pageerror", (e: Error) => errors.push(e.message));
        page.on("console", (m: { type: () => string; text: () => string; location: () => { url?: string } }) => m.type() === "error" && !(m.location()?.url ?? "").endsWith("/favicon.ico") && consoleErrors.push(m.text()));
        const own = (u: string) => u.startsWith(base) && !u.endsWith("/favicon.ico"); // browsers probe favicon.ico unprompted
        const requests: { method: string; path: string; status: number }[] = [];
        page.on("response", (res: { url: () => string; status: () => number; request: () => { method: () => string } }) => {
          if (!own(res.url())) return;
          const p = new URL(res.url()).pathname;
          if (p.startsWith("/api/") && requests.length < 50) requests.push({ method: res.request().method(), path: p, status: res.status() });
          if (res.status() >= 400) failed.push(`${res.status()} ${res.url().slice(base.length)}`);
        });
        page.on("requestfailed", (req: { url: () => string; failure: () => { errorText: string } | null }) => own(req.url()) && failed.push(`${req.failure()?.errorText ?? "failed"} ${req.url().slice(base.length)}`));
        const ts = Date.now();
        let status: number | null = null;
        try {
          const resp = await page.goto(`${base}${route}`, { waitUntil: "networkidle", timeout: 15_000 });
          status = resp?.status() ?? null;
        } catch (e) {
          findings.push({ kind: "load_failed", route, viewport: vp.name, detail: (e as Error).message.slice(0, 300), severity: "high", blocking: true });
        }
        if (status !== null && status >= 400) findings.push({ kind: "load_failed", route, viewport: vp.name, detail: `HTTP ${status}`, severity: "high", blocking: true });
        const audit = await page.evaluate(() => {
          const d = document.documentElement;
          const overflow = d.scrollWidth - window.innerWidth;
          const named = (el: Element) => !!((el as HTMLElement).innerText?.trim() || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title") || (el as HTMLInputElement).value);
          const visible = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const unnamedButtons = [...document.querySelectorAll("button, [role=button], a[href]")].filter(visible).filter((el) => !named(el) && !el.querySelector("img[alt]:not([alt=''])")).map((el) => el.outerHTML.slice(0, 120));
          const unlabeled = [...document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea")].filter(visible).filter((el) => { const id = el.getAttribute("id"); return !(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (id && document.querySelector(`label[for="${id}"]`)) || el.closest("label")); }).map((el) => el.outerHTML.slice(0, 120));
          const inert = [...document.querySelectorAll("button")].filter(visible).filter((b) => !b.closest("form") && !b.hasAttribute("onclick") && !b.getAttribute("data-action") && !b.id && !b.getAttribute("data-testid") && b.type !== "submit").map((b) => b.outerHTML.slice(0, 120));
          return { overflow, unnamedButtons, unlabeled, inert, forms: document.querySelectorAll("form").length };
        }).catch(() => null);
        if (errors.length) findings.push({ kind: "page_error", route, viewport: vp.name, detail: errors.slice(0, 3).join(" | ").slice(0, 600), severity: "high", blocking: true });
        if (consoleErrors.length) findings.push({ kind: "console_error", route, viewport: vp.name, detail: consoleErrors.slice(0, 3).join(" | ").slice(0, 600), severity: "medium", blocking: true });
        if (failed.length) findings.push({ kind: "request_failed", route, viewport: vp.name, detail: [...new Set(failed)].slice(0, 5).join(", "), severity: "high", blocking: true });
        if (audit && audit.overflow > 4) findings.push({ kind: "overflow", route, viewport: vp.name, detail: `the page is ${audit.overflow}px wider than the ${vp.width}px viewport (horizontal scrolling)`, severity: vp.name === "mobile" ? "high" : "medium", blocking: vp.name === "mobile" });
        if (audit?.unnamedButtons.length) findings.push({ kind: "unlabeled_control", route, viewport: vp.name, detail: `controls without an accessible name: ${audit.unnamedButtons.slice(0, 3).join(" ")}`, severity: "medium", blocking: true });
        if (audit?.unlabeled.length) findings.push({ kind: "unlabeled_control", route, viewport: vp.name, detail: `form fields without a label: ${audit.unlabeled.slice(0, 3).join(" ")}`, severity: "medium", blocking: true });
        if (audit?.inert.length) findings.push({ kind: "inert_button", route, viewport: vp.name, detail: `buttons outside a form with no id/data-action (possibly dead): ${audit.inert.slice(0, 3).join(" ")}`, severity: "low", blocking: false });
        let shot: string | null = null;
        try {
          const file = join(args.evidenceDir, `${vp.name}${route === "/" ? "-index" : route.replace(/[^a-z0-9]+/gi, "-")}.png`);
          await writeFile(file, await page.screenshot({ fullPage: true }));
          shot = file;
        } catch {
          /* screenshot optional */
        }
        routesOut.push({ route, viewport: vp.name, httpStatus: status, screenshot: shot, ms: Date.now() - ts, requests });
        await page.close();
      }
      await ctx.close();
    }

    // Persistence journey through the real UI: fill the first form, submit, reload, the value persists.
    const collections = collectionRoutes(args.apiRoutes);
    if (!collections.length) journeys.push({ name: "create → reload → persists", status: "not_run", detail: "no JSON collection API (POST + GET /api/<name>) found to verify against" });
    else {
      const ctx = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      const marker = `aura-check-${randomBytes(3).toString("hex")}`;
      try {
        await page.goto(`${base}/`, { waitUntil: "networkidle", timeout: 15_000 });
        const filled = await page.evaluate((m: string) => {
          const form = document.querySelector("form");
          if (!form) return { ok: false, why: "no form on the start page" };
          let textSet = false;
          for (const el of [...form.querySelectorAll("input, select, textarea")] as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[]) {
            if (el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
            if (el instanceof HTMLSelectElement) { const opt = [...el.options].find((o) => o.value); if (opt) el.value = opt.value; }
            else if (el.type === "number") el.value = "12.5";
            else if (el.type === "date") el.value = new Date().toISOString().slice(0, 10);
            else if (el.type === "month") el.value = new Date().toISOString().slice(0, 7);
            else if (el.type === "email") el.value = "check@example.com";
            else if (el.type === "checkbox" || el.type === "radio") (el as HTMLInputElement).checked = true;
            else { el.value = textSet ? "detail" : m; textSet = true; }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return { ok: textSet, why: textSet ? "" : "the form has no text field to put a recognisable value in" };
        }, marker);
        if (!filled.ok) journeys.push({ name: "create → reload → persists", status: "not_run", detail: filled.why });
        else {
          const posted = page.waitForResponse((res: { url: () => string; request: () => { method: () => string } }) => res.request().method() === "POST" && collections.some((c) => res.url().startsWith(`${base}${c}`)), { timeout: 8000 }).catch(() => null);
          await page.evaluate(() => { const f = document.querySelector("form")!; (f.querySelector("[type=submit]") as HTMLElement | null)?.click() ?? f.requestSubmit(); });
          const resp = await posted;
          if (!resp) journeys.push({ name: "create → reload → persists", status: "failed", detail: `submitting the form did not call ${collections.join(" or ")}` });
          else if (resp.status() >= 400) journeys.push({ name: "create → reload → persists", status: "failed", detail: `${resp.request().method()} ${resp.url().slice(base.length)} returned ${resp.status()}: ${(await resp.text().catch(() => "")).slice(0, 200)}` });
          else {
            await page.waitForTimeout(500);
            const shown = (await page.content()).includes(marker);
            await page.reload({ waitUntil: "networkidle" });
            const persisted = (await page.content()).includes(marker);
            // State must be consistent after a mutation: the new record is visible WITHOUT a manual reload, and survives one.
            journeys.push(persisted && shown ? { name: "create → reload → persists", status: "passed", detail: `created via the form (${resp.status()}), shown immediately and still listed after reload` }
              : { name: "create → reload → persists", status: "failed", detail: persisted ? "the API stored the record but the page did not show it until a manual reload (the list/totals are not refreshed after saving)" : shown ? "the new record was shown but disappeared after reload (not persisted, or the page does not load from the API)" : "the API accepted the record but the page never displayed it (list not refreshed / not rendered)" });
          }
        }
      } catch (e) {
        journeys.push({ name: "create → reload → persists", status: "failed", detail: (e as Error).message.slice(0, 300) });
      }
      await ctx.close();
    }
    for (const j of journeys.filter((x) => x.status === "failed")) findings.push({ kind: "journey_failed", route: "/", viewport: "desktop", detail: `${j.name}: ${j.detail}`, severity: "high", blocking: true });
    return { status: findings.some((f) => f.blocking) ? "failed" : "passed", routes: routesOut, findings, journeys, durationMs: Date.now() - t0 };
  } catch (e) {
    log("warn", "browser.verify_error", { buildId: args.buildId, error: (e as Error).message });
    return { ...empty("unavailable", `Browser verification could not run: ${(e as Error).message.slice(0, 300)}`), routes: routesOut, findings };
  } finally {
    await browser?.close().catch(() => null);
    await stopApp?.();
  }
}

export function evidenceRoot() {
  return process.env.AURA_EVIDENCE_ROOT?.trim() || join(tmpdir(), "aura-evidence");
}

/** Brief for the implementing engineer: route, viewport, observed vs expected (V10 §9). */
export function browserBrief(r: BrowserResult) {
  if (r.status === "unavailable") return "";
  const lines = r.findings.filter((f) => f.blocking).map((f) => `- [${f.kind}] ${f.route} @ ${f.viewport}: ${f.detail}`);
  const j = r.journeys.map((x) => `- journey "${x.name}": ${x.status} — ${x.detail}`);
  return lines.length || j.length ? `# Browser verification (real Chromium against the running app)\n${[...lines, ...j].join("\n")}` : "";
}



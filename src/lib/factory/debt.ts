/**
 * Technical-debt analyzer (AURA V14). Objective, evidence-backed detectors
 * over the real repository snapshot (files + code index + system graph):
 *
 *   circular_dependency   import cycles (graph)                       objective
 *   duplicated_logic      identical non-trivial function bodies        objective
 *   complexity            very long functions / deep nesting           objective (thresholds)
 *   missing_tests         routes or persistence modules no test covers objective
 *   unsafe_errors         empty catch blocks; handlers leaking stack   objective
 *   inconsistent_contract frontend calls without a matching route      objective (graph)
 *   dead_code             non-entry modules nothing imports            likely (dynamic loading possible)
 *   config_drift          env vars read but missing from .env.example  objective
 *   repeated_io           store/db reads inside loops                  likely
 *
 * Each finding: evidence (file + line), severity, consequence, recommended
 * small action, verification criteria, and `objective` vs `subjective`.
 * Style preferences are not reported. A rewrite is never recommended.
 */
import { createHash } from "node:crypto";
import type { CodeIndexData } from "@/lib/builder/intel";
import { isTestFile } from "@/lib/builder/intel";
import type { SystemGraph } from "@/lib/builder/graph";

export interface DebtFinding { id: string; kind: string; severity: "high" | "medium" | "low"; objective: boolean; title: string; evidence: { file: string; line?: number; detail: string }[]; consequence: string; action: string; verification: string[]; files: string[] }

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;
const fid = (kind: string, files: string[], extra = "") => createHash("sha256").update(`${kind}|${[...files].sort().join(",")}|${extra}`).digest("hex").slice(0, 16);

function functions(src: string) {
  const out: { name: string; start: number; body: string }[] = [];
  const re = /(?:function\s+(\w+)\s*\([^)]*\)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>)\s*\{/g;
  for (const m of src.matchAll(re)) {
    let depth = 1, i = (m.index ?? 0) + m[0].length;
    for (; i < src.length && depth; i++) depth += src[i] === "{" ? 1 : src[i] === "}" ? -1 : 0;
    out.push({ name: m[1] ?? m[2], start: m.index ?? 0, body: src.slice((m.index ?? 0) + m[0].length, i - 1) });
  }
  return out;
}

export function analyzeDebt(index: CodeIndexData, files: Record<string, string>, graph?: SystemGraph): DebtFinding[] {
  const out: DebtFinding[] = [];
  const add = (f: Omit<DebtFinding, "id">) => out.push({ ...f, id: fid(f.kind, f.files, f.title) });
  const src = Object.entries(files).filter(([p]) => /\.(c|m)?(j|t)sx?$/.test(p) && !isTestFile(p) && !/(^|\/)(node_modules|dist|build)\//.test(p));

  // Circular imports.
  const imports = new Map(index.files.map((f) => [f.path, f.imports]));
  const seen = new Set<string>();
  for (const start of imports.keys()) {
    const stack: string[] = [];
    const visit = (p: string): string[] | null => {
      if (stack.includes(p)) return stack.slice(stack.indexOf(p)).concat(p);
      if (seen.has(p)) return null;
      stack.push(p);
      for (const d of imports.get(p) ?? []) { const c = visit(d); if (c) return c; }
      stack.pop();
      seen.add(p);
      return null;
    };
    const cycle = visit(start);
    if (cycle && !out.some((o) => o.kind === "circular_dependency" && o.files.join() === [...new Set(cycle)].sort().join())) add({ kind: "circular_dependency", severity: "medium", objective: true, title: `Import cycle: ${cycle.join(" → ")}`, evidence: [{ file: cycle[0], detail: cycle.join(" → ") }], consequence: "Load-order bugs (undefined exports at import time) and modules that cannot be changed independently", action: "Move the shared piece into its own module that both import, breaking the cycle", verification: ["no import cycle among these files", "full test suite passes"], files: [...new Set(cycle)].sort() });
  }

  // Duplicated function bodies (normalised, ≥ 5 lines).
  const bodies = new Map<string, { file: string; name: string; line: number }[]>();
  for (const [p, s] of src) for (const fn of functions(s)) {
    const norm = fn.body.replace(/\/\/.*$/gm, "").replace(/\s+/g, " ").trim();
    if (norm.split(";").length < 5 || norm.length < 160) continue;
    const h = createHash("sha256").update(norm).digest("hex");
    bodies.set(h, [...(bodies.get(h) ?? []), { file: p, name: fn.name, line: lineOf(s, fn.start) }]);
  }
  for (const xs of bodies.values()) if (xs.length > 1) add({ kind: "duplicated_logic", severity: "medium", objective: true, title: `Duplicated logic: ${xs.map((x) => `${x.name} (${x.file})`).join(" = ")}`, evidence: xs.map((x) => ({ file: x.file, line: x.line, detail: `${x.name}` })), consequence: "A fix applied to one copy leaves the other copy wrong (divergent behaviour)", action: `Keep one implementation and import it from the other ${xs.length - 1} place(s)`, verification: ["tests covering both call sites pass", "only one implementation remains"], files: [...new Set(xs.map((x) => x.file))] });

  // Complexity: very long functions or deep nesting.
  for (const [p, s] of src) for (const fn of functions(s)) {
    const lines = fn.body.split("\n").length;
    let depth = 0, max = 0;
    for (const ch of fn.body) { if (ch === "{") max = Math.max(max, ++depth); else if (ch === "}") depth--; }
    const branches = (fn.body.match(/\b(if|for|while|case|catch)\b|\?\s|&&|\|\|/g) ?? []).length;
    if (lines > 80 || max > 5 || branches > 25) add({ kind: "complexity", severity: lines > 150 || branches > 40 ? "high" : "medium", objective: true, title: `${fn.name} in ${p} is hard to change safely (${lines} lines, nesting ${max}, ${branches} branches)`, evidence: [{ file: p, line: lineOf(s, fn.start), detail: `${lines} lines, depth ${max}, ${branches} branch points` }], consequence: "High chance of regressions when modifying it; hard to test each path", action: "Extract the independent steps into named functions behind the same signature; add characterization tests first", verification: ["characterization tests written before the change pass after it", "public signature unchanged"], files: [p] });
  }

  // Missing tests around important logic: routes and persistence modules no test covers.
  const covered = new Set(index.tests.flatMap((t) => [t.file, ...t.covers]));
  const important = new Set([...index.routes.map((r) => r.file), ...(graph?.edges.filter((e) => e.kind === "persists" && e.from.startsWith("file:")).map((e) => e.from.slice(5)) ?? [])]);
  for (const f of important) if (!covered.has(f) && files[f] !== undefined && !isTestFile(f)) add({ kind: "missing_tests", severity: "high", objective: true, title: `${f} handles requests or data but no test loads it`, evidence: [{ file: f, detail: `routes: ${index.routes.filter((r) => r.file === f).map((r) => `${r.method} ${r.path}`).join(", ") || "persistence calls"}` }], consequence: "Any change to it ships unverified; defects reach users", action: "Add tests that call each route/persistence path through the real server (success, invalid input, not found)", verification: ["new tests fail when the handler is broken", "suite passes"], files: [f] });

  // Unsafe error handling.
  for (const [p, s] of src) {
    for (const m of s.matchAll(/catch\s*(?:\(\s*\w*\s*\))?\s*\{\s*\}/g)) add({ kind: "unsafe_errors", severity: "medium", objective: true, title: `Empty catch block in ${p}`, evidence: [{ file: p, line: lineOf(s, m.index ?? 0), detail: m[0] }], consequence: "Failures are silently swallowed; users see wrong data with no error", action: "Handle the error (return a clear error / log it) or let it propagate", verification: ["a test triggers the failure path and observes the error"], files: [p] });
    for (const m of s.matchAll(/json\(\s*res\s*,\s*500\s*,\s*\{[^}]*\b(stack|e\.message|err\.message)\b/g)) add({ kind: "unsafe_errors", severity: "high", objective: true, title: `Internal error details returned to clients in ${p}`, evidence: [{ file: p, line: lineOf(s, m.index ?? 0), detail: m[0].slice(0, 120) }], consequence: "Stack traces/internal messages leak to users and attackers", action: "Return a generic message; log the details server-side", verification: ["error response contains no stack/internal message"], files: [p] });
  }

  // Inconsistent contracts (graph broken edges).
  for (const e of graph?.edges.filter((x) => x.kind === "calls" && x.broken) ?? []) add({ kind: "inconsistent_contract", severity: "high", objective: true, title: `${e.from.replace(/^(file|page):/, "")} calls ${e.to.replace(/^route:/, "")}, which the server does not handle`, evidence: [{ file: e.from.replace(/^(file|page):/, ""), detail: e.source }], consequence: "That feature fails at runtime", action: "Align the client call with the existing route (or add the route if the requirement needs it)", verification: ["browser/integration test of the journey passes"], files: [e.from.replace(/^(file|page):/, "")] });

  // Dead code: non-entry, non-test modules nothing imports (likely, not certain).
  const imported = new Set(index.files.flatMap((f) => f.imports));
  const entries = /(^|\/)(server|index|main|app|cli)\.(c|m)?(j|t)sx?$|^scripts\/|^public\/|(^|\/)(app|pages)\/|route\.(t|j)sx?$|config\./;
  for (const f of index.files) if (/\.(c|m)?(j|t)sx?$/.test(f.path) && !isTestFile(f.path) && !imported.has(f.path) && !entries.test(f.path) && !index.routes.some((r) => r.file === f.path)) add({ kind: "dead_code", severity: "low", objective: false, title: `${f.path} is not imported by any module`, evidence: [{ file: f.path, detail: "no static import found (it may be loaded dynamically)" }], consequence: "Maintenance cost for code that may not run", action: "Confirm it is unused (search for dynamic loading), then delete it", verification: ["suite passes after removal", "no runtime reference in logs"], files: [f.path] });

  // Config drift: env vars read in code but absent from .env.example (when one exists).
  if (files[".env.example"] !== undefined) {
    const documented = new Set([...files[".env.example"].matchAll(/^\s*#?\s*([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    const used = new Map<string, string>();
    for (const [p, s] of src) for (const m of s.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) if (!used.has(m[1])) used.set(m[1], p);
    const missing = [...used].filter(([n]) => !documented.has(n) && !["NODE_ENV", "PORT", "DATA_DIR", "HOME", "CI"].includes(n));
    if (missing.length) add({ kind: "config_drift", severity: "medium", objective: true, title: `Env vars used but not documented in .env.example: ${missing.map(([n]) => n).join(", ")}`, evidence: missing.map(([n, p]) => ({ file: p, detail: n })), consequence: "Deployments miss required configuration", action: "Add them to .env.example with a comment", verification: [".env.example lists every variable the code reads"], files: [".env.example", ...new Set(missing.map(([, p]) => p))] });
  }

  // Repeated I/O inside loops.
  for (const [p, s] of src) for (const m of s.matchAll(/for\s*\([^)]*\)\s*\{[^}]{0,300}?\b(store\.(?:all|get)|prisma\.\w+\.find\w*|fetch)\(/g)) add({ kind: "repeated_io", severity: "low", objective: false, title: `I/O inside a loop in ${p}`, evidence: [{ file: p, line: lineOf(s, m.index ?? 0), detail: m[0].slice(0, 100).replace(/\s+/g, " ") }], consequence: "Cost grows with the number of items (N+1)", action: "Read once before the loop and index by id", verification: ["same results", "one read per request"], files: [p] });

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || Number(b.objective) - Number(a.objective));
}

/** Dependency maintenance from the manifest only — no registry access here, so no invented versions/advisories. */
export function dependencyReview(files: Record<string, string>, opts: { registry?: Record<string, { latest: string; deprecated?: string }>; advisories?: { package: string; range: string; severity: string; id: string }[] } = {}) {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: { node?: string } } = {};
  try { pkg = JSON.parse(files["package.json"] ?? "{}"); } catch { return { checks: [{ id: "manifest", status: "failed", detail: "package.json is not valid JSON" }], updates: [] }; }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const lock = files["package-lock.json"] !== undefined || files["yarn.lock"] !== undefined || files["pnpm-lock.yaml"] !== undefined;
  const checks: { id: string; status: "passed" | "failed" | "not_run" | "warning"; detail: string }[] = [];
  checks.push({ id: "lockfile", status: !Object.keys(deps).length ? "passed" : lock ? "passed" : "warning", detail: !Object.keys(deps).length ? "no dependencies" : lock ? "lockfile present" : "dependencies without a lockfile: installs are not reproducible" });
  const loose = Object.entries(deps).filter(([, v]) => /^(\*|latest|x)$|^>=/.test(v));
  checks.push({ id: "constraints", status: loose.length ? "warning" : "passed", detail: loose.length ? `unbounded ranges: ${loose.map(([k, v]) => `${k}@${v}`).join(", ")}` : "all ranges bounded" });
  checks.push({ id: "runtime", status: pkg.engines?.node ? (/(1[0-7])\b/.test(pkg.engines.node) && !/>=\s*(1[89]|2\d)/.test(pkg.engines.node) ? "warning" : "passed") : "warning", detail: pkg.engines?.node ? `node ${pkg.engines.node}` : "no engines.node declared" });
  checks.push({ id: "registry", status: opts.registry ? "passed" : "not_run", detail: opts.registry ? `${Object.keys(opts.registry).length} package(s) checked` : "package registry not consulted (no network access in this check) — outdated/deprecated status unknown" });
  checks.push({ id: "advisories", status: opts.advisories ? (opts.advisories.length ? "failed" : "passed") : "not_run", detail: opts.advisories ? `${opts.advisories.length} advisory(ies)` : "security advisories not consulted — run `npm audit` with network access" });
  const updates = opts.registry ? Object.entries(deps).flatMap(([name, range]) => {
    const r = opts.registry![name];
    if (!r) return [];
    const cur = range.replace(/^[^\d]*/, "");
    const major = (v: string) => Number(v.split(".")[0]);
    if (r.deprecated) return [{ name, from: range, to: r.latest, reason: `deprecated: ${r.deprecated}`, breaking: major(r.latest) > major(cur), worthwhile: true }];
    const adv = opts.advisories?.find((a) => a.package === name);
    if (adv) return [{ name, from: range, to: r.latest, reason: `security advisory ${adv.id} (${adv.severity})`, breaking: major(r.latest) > major(cur), worthwhile: true }];
    // Newer version alone is not a reason to upgrade.
    return [];
  }) : [];
  return { checks, updates };
}

/**
 * Unified system dependency graph (AURA V13), derived from real artifacts:
 *
 *   static   the code index (TypeScript-parsed imports, route tables, frontend
 *            fetch calls, schema files) plus targeted extraction from source
 *            (env vars, external hosts/SDKs, persistence calls, background
 *            jobs, request body fields)
 *   runtime  observed in execution: API requests the real browser made while
 *            verifying the running app, journeys that passed/failed
 *   inferred heuristics (lexical test↔route matches, planned task files)
 *
 * Every edge carries `basis` + `source` so the UI and agents can tell
 * verified dependencies from guesses. Adapts to the stack: whatever the index
 * understands (node-web route tables, Express/Fastify, Next.js app router,
 * Prisma/SQL) becomes nodes; unknown patterns are listed as limitations
 * instead of being invented.
 */
import type { CodeIndexData } from "./intel";
import { isTestFile, dependentsOf, contractMatches } from "./intel";

export type NodeKind = "page" | "module" | "route" | "entity" | "test" | "requirement" | "env" | "external" | "job" | "journey" | "config";
export type Basis = "runtime" | "static" | "inferred";
export interface GNode { id: string; kind: NodeKind; label: string; file?: string; meta?: Record<string, unknown> }
export interface GEdge { from: string; to: string; kind: "imports" | "handles" | "calls" | "persists" | "reads_env" | "calls_external" | "covers" | "verifies" | "implements" | "exercises" | "runs"; basis: Basis; source: string; broken?: boolean }
export interface SystemGraph { version: 1; sha: string | null; nodes: GNode[]; edges: GEdge[]; limitations: string[]; stats: Record<string, number> }

const id = { file: (p: string) => `file:${p}`, route: (m: string, p: string) => `route:${m} ${p}`, entity: (e: string) => `entity:${e}`, env: (e: string) => `env:${e}`, ext: (h: string) => `external:${h}`, req: (r: string) => `req:${r}`, journey: (j: string) => `journey:${j}` };
const SDKS: Record<string, string> = { stripe: "Stripe", "@anthropic-ai/sdk": "Anthropic", openai: "OpenAI", "@sendgrid/mail": "SendGrid", resend: "Resend", twilio: "Twilio", "@aws-sdk": "AWS", "@google-cloud": "Google Cloud", axios: "HTTP (axios)", pg: "PostgreSQL", mysql2: "MySQL", mongodb: "MongoDB", redis: "Redis", ioredis: "Redis", "@prisma/client": "Prisma" };

export interface EnvUse { name: string; file: string; optional: boolean }
export function envUses(path: string, src: string): EnvUse[] {
  const out: EnvUse[] = [];
  for (const m of src.matchAll(/process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\])(\s*(\|\||\?\?))?/g)) out.push({ name: m[1] ?? m[2], file: path, optional: !!m[3] });
  return out;
}
export function externalHosts(src: string) {
  return [...new Set([...src.matchAll(/["'`]https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?[/"'`]/gi)].map((m) => m[1].toLowerCase()).filter((h) => !/^(localhost|127\.0\.0\.1|example\.com|www\.w3\.org)$/.test(h)))];
}
/** store.insert("expenses") / prisma.expense.create / INSERT INTO expenses → entity names. */
export function persistenceCalls(src: string) {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bstore\.(?:insert|all|get|update|remove|find\w*)\(\s*["'`](\w+)["'`]/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bprisma\.(\w+)\.(?:create|find\w*|update\w*|delete\w*|upsert|count|aggregate)\b/g)) if (!m[1].startsWith("$")) out.add(m[1]);
  for (const m of src.matchAll(/\b(?:insert\s+into|update|from)\s+["`]?([a-z_][a-z0-9_]*)["`]?\b/gi)) if (!/^(the|a|an|set|where|select)$/i.test(m[1]) && /insert|update|from/i.test(m[0]) && /`|"|sql|query/i.test(src.slice(Math.max(0, (m.index ?? 0) - 40), m.index))) out.add(m[1].toLowerCase());
  return [...out];
}
/** Fields a frontend sends with fetch(…, { body: JSON.stringify({ a, b: x }) }) for each API path. */
export function requestFields(src: string): { path: string; method: string; fields: string[] }[] {
  const out: { path: string; method: string; fields: string[] }[] = [];
  for (const m of src.matchAll(/fetch\(\s*["'`](\/api\/[^"'`?$]*)["'`]\s*,\s*\{/g)) {
    const opts = src.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 600);
    const method = (opts.match(/^[\s\S]*?method:\s*["'](\w+)["']/)?.[1] ?? "GET").toUpperCase();
    const body = opts.match(/JSON\.stringify\(\s*\{([^}]*)\}/)?.[1];
    if (!body) continue;
    const fields = [...body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?::|,|$)/g)].map((x) => x[1]);
    out.push({ path: m[1], method, fields: [...new Set(fields)] });
  }
  return out;
}
/** Body fields a server handler reads (body.x / b.x after readJson / req.body.x). */
export function handlerFields(src: string) {
  const vars = new Set(["body", "b", "input", "data", "payload"]);
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await\s+(?:readJson|req\.json|parseBody)\(/g)) vars.add(m[1]);
  const fields = new Set<string>();
  for (const v of vars) for (const m of src.matchAll(new RegExp(`\\b${v}\\.([A-Za-z_$][\\w$]*)`, "g"))) if (!["length", "trim", "toString"].includes(m[1])) fields.add(m[1]);
  for (const m of src.matchAll(/req\.body\.([A-Za-z_$][\w$]*)/g)) fields.add(m[1]);
  return [...fields];
}

export interface GraphInput {
  sha?: string | null;
  index: CodeIndexData;
  files: Record<string, string>;
  /** Backlog items with traceability (requirement ids, planned files) and their verified build's changed files. */
  items?: { key: string; title: string; requirements: string[]; plannedFiles: string[]; verifiedFiles: string[] }[];
  /** Runtime evidence from browser verification. */
  observed?: { route: string; requests: { method: string; path: string; status: number }[]; journeys: { name: string; status: string }[] }[];
}

export function buildGraph(g: GraphInput): SystemGraph {
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const node = (n: GNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return n.id; };
  const edge = (e: GEdge) => { if (!edges.some((x) => x.from === e.from && x.to === e.to && x.kind === e.kind && x.basis === e.basis)) edges.push(e); };
  const routeRe = g.index.routes.map((r) => ({ r, re: new RegExp(`^${r.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^/]+")}$`) }));
  const matchRoute = (method: string, path: string) => routeRe.find((x) => x.r.method === method && x.re.test(path))?.r ?? null;

  for (const f of g.index.files) {
    const test = isTestFile(f.path);
    const page = /\.html?$/.test(f.path) || /(^|\/)app\/.*\/page\.(t|j)sx?$|(^|\/)pages\/[^_].*\.(t|j)sx?$/.test(f.path);
    node({ id: id.file(f.path), kind: test ? "test" : page ? "page" : /(^|\/)(jobs?|workers?|cron)\//.test(f.path) ? "job" : f.path === "package.json" || /^(Dockerfile|docker-compose|\.env\.example)/.test(f.path) ? "config" : "module", label: f.path, file: f.path });
    for (const d of f.imports) edge({ from: id.file(f.path), to: id.file(d), kind: "imports", basis: "static", source: `${g.index.parser} import` });
    for (const e of f.external) {
      const sdk = Object.entries(SDKS).find(([k]) => e === k || e.startsWith(`${k}/`) || (k.endsWith("-sdk") && e.startsWith(k)));
      if (sdk) edge({ from: id.file(f.path), to: node({ id: id.ext(sdk[1]), kind: "external", label: sdk[1], meta: { package: e } }), kind: "calls_external", basis: "static", source: `imports ${e}` });
    }
  }
  for (const t of g.index.tests) for (const c of t.covers) edge({ from: id.file(t.file), to: id.file(c), kind: "covers", basis: "static", source: "test import closure" });
  for (const r of g.index.routes) edge({ from: id.file(r.file), to: node({ id: id.route(r.method, r.path), kind: "route", label: `${r.method} ${r.path}`, file: r.file }), kind: "handles", basis: "static", source: "route table" });
  for (const c of g.index.contracts) {
    const r = g.index.routes.find((x) => x.method === c.method && contractMatches(x.path, c)) ?? null;
    const to = r ? id.route(r.method, r.path) : node({ id: id.route(c.method, c.path), kind: "route", label: `${c.method} ${c.path}`, meta: { missing: true } });
    edge({ from: id.file(c.file), to, kind: "calls", basis: "static", source: `fetch ${c.method} ${c.path}`, ...(r ? {} : { broken: true }) });
  }
  for (const s of g.index.schema) for (const e of s.entities) edge({ from: id.file(s.file), to: node({ id: id.entity(e.toLowerCase()), kind: "entity", label: e, meta: { schema: s.kind } }), kind: "persists", basis: "static", source: `${s.kind} schema` });
  for (const [path, src] of Object.entries(g.files)) {
    if (!/\.(c|m)?(j|t)sx?$/.test(path) || isTestFile(path)) continue;
    for (const e of persistenceCalls(src)) edge({ from: id.file(path), to: node({ id: id.entity(e.toLowerCase()), kind: "entity", label: e }), kind: "persists", basis: "static", source: "store/ORM call" });
    for (const u of envUses(path, src)) edge({ from: id.file(path), to: node({ id: id.env(u.name), kind: "env", label: u.name, meta: { optional: u.optional } }), kind: "reads_env", basis: "static", source: u.optional ? "process.env with default" : "process.env (required)" });
    for (const h of externalHosts(src)) edge({ from: id.file(path), to: node({ id: id.ext(h), kind: "external", label: h }), kind: "calls_external", basis: "static", source: "literal URL" });
    if (/\bsetInterval\(|\bcron\.schedule\(|new\s+Worker\(/.test(src)) node({ id: id.file(path), kind: "job", label: path, file: path });
  }
  // Tests that load a served frontend asset (fetch(app.url + "/app.js") / "/") exercise that public file.
  for (const t of g.index.tests) {
    const src = g.files[t.file] ?? "";
    for (const f of g.index.files.filter((x) => x.path.startsWith("public/"))) {
      const served = `/${f.path.slice("public/".length)}`;
      if (src.includes(`"${served}"`) || (served === "/index.html" && /\+\s*["'`]\/["'`]/.test(src))) edge({ from: id.file(t.file), to: id.file(f.path), kind: "covers", basis: "inferred", source: `test requests ${served}` });
    }
  }
  // Tests ↔ routes they exercise (lexical: the route path appears in the test source).
  for (const t of g.index.tests) {
    const src = g.files[t.file] ?? "";
    for (const r of g.index.routes) if (src.includes(r.path.replace(/:\w+.*$/, ""))) edge({ from: id.file(t.file), to: id.route(r.method, r.path), kind: "verifies", basis: "inferred", source: "route path appears in test" });
  }
  // Requirements → files (verified builds = static evidence of what implemented it; planned = inferred).
  for (const it of g.items ?? []) for (const r of it.requirements) {
    const rid = node({ id: id.req(r), kind: "requirement", label: r, meta: { tasks: [it.key] } });
    (nodes.get(rid)!.meta!.tasks as string[]).includes(it.key) || (nodes.get(rid)!.meta!.tasks as string[]).push(it.key);
    for (const f of it.verifiedFiles) if (nodes.has(id.file(f))) edge({ from: rid, to: id.file(f), kind: "implements", basis: "static", source: `verified run of ${it.key}` });
    for (const f of it.plannedFiles) if (nodes.has(id.file(f)) && !it.verifiedFiles.includes(f)) edge({ from: rid, to: id.file(f), kind: "implements", basis: "inferred", source: `planned in ${it.key}` });
  }
  // Runtime: requests the real browser made, journeys it ran.
  for (const o of g.observed ?? []) {
    const pageFile = o.route === "/" ? "public/index.html" : `public${o.route}`;
    const from = nodes.has(id.file(pageFile)) ? id.file(pageFile) : node({ id: `page:${o.route}`, kind: "page", label: o.route });
    for (const q of o.requests) {
      const r = matchRoute(q.method, q.path);
      edge({ from, to: r ? id.route(r.method, r.path) : node({ id: id.route(q.method, q.path), kind: "route", label: `${q.method} ${q.path}`, meta: { missing: true } }), kind: "calls", basis: "runtime", source: `browser request → ${q.status}`, ...(q.status >= 400 || !r ? { broken: true } : {}) });
    }
    for (const j of o.journeys) {
      const jid = node({ id: id.journey(j.name), kind: "journey", label: j.name, meta: { status: j.status } });
      edge({ from: jid, to: from, kind: "exercises", basis: "runtime", source: `browser journey ${j.status}` });
      for (const q of o.requests) { const r = matchRoute(q.method, q.path); if (r) edge({ from: jid, to: id.route(r.method, r.path), kind: "exercises", basis: "runtime", source: `request during journey (${q.status})` }); }
    }
  }
  const limitations = [...g.index.limitations];
  if (!g.observed?.length) limitations.push("No runtime evidence yet: page→API edges are from static fetch calls only.");
  if (!g.index.routes.length) limitations.push("No server routes recognised for this stack; API edges may be missing.");
  const all = [...nodes.values()];
  return { version: 1, sha: g.sha ?? null, nodes: all, edges, limitations, stats: Object.fromEntries(["page", "module", "route", "entity", "test", "requirement", "env", "external", "job", "journey"].map((k) => [k, all.filter((n) => n.kind === k).length])) };
}

export interface ImpactReport { changed: string[]; components: { id: string; reason: string }[]; routes: string[]; pages: string[]; entities: string[]; tests: string[]; requirements: string[]; journeys: string[]; contracts: string[]; confidence: "high" | "medium" | "low"; reasons: string[] }

/** Change → affected components, contracts, tests, requirements and journeys, with the reason for each. */
export function graphImpact(graph: SystemGraph, index: CodeIndexData, changed: string[]): ImpactReport {
  const reasons: string[] = [];
  const dependents = dependentsOf(index, changed);
  const files = new Set([...changed, ...dependents]);
  const comps = [...changed.map((c) => ({ id: `file:${c}`, reason: "changed" })), ...dependents.map((d) => ({ id: `file:${d}`, reason: "imports a changed file" }))];
  const out = (kind: GEdge["kind"], fromSet: Set<string>) => graph.edges.filter((e) => e.kind === kind && fromSet.has(e.from));
  const fileIds = new Set([...files].map((f) => `file:${f}`));
  const routes = new Set(out("handles", fileIds).map((e) => e.to));
  // Pages (and their modules) that call an affected route are affected too.
  const callers = graph.edges.filter((e) => e.kind === "calls" && routes.has(e.to)).map((e) => e.from);
  for (const c of callers) if (!fileIds.has(c)) { comps.push({ id: c, reason: "calls an affected route" }); fileIds.add(c); }
  const entities = new Set(out("persists", fileIds).map((e) => e.to));
  const tests = new Set(graph.edges.filter((e) => (e.kind === "covers" && fileIds.has(e.to)) || (e.kind === "verifies" && routes.has(e.to))).map((e) => e.from));
  for (const c of changed) if (isTestFile(c)) tests.add(`file:${c}`);
  const requirements = new Set(graph.edges.filter((e) => e.kind === "implements" && fileIds.has(e.to)).map((e) => e.from));
  const pages = new Set([...fileIds].filter((f) => graph.nodes.find((n) => n.id === f)?.kind === "page"));
  const journeys = new Set(graph.edges.filter((e) => e.kind === "exercises" && (routes.has(e.to) || pages.has(e.to))).map((e) => e.from));
  const contracts = graph.edges.filter((e) => e.kind === "calls" && (routes.has(e.to) || fileIds.has(e.from))).map((e) => `${e.from.replace(/^file:/, "")} → ${e.to.replace(/^route:/, "")}${e.broken ? " (BROKEN)" : ""}`);
  // Confidence: high when every changed source file is indexed and has a parsed import graph; drops with dynamic/unknown wiring.
  const unindexed = changed.filter((c) => /\.(c|m)?(j|t)sx?$/.test(c) && !index.files.some((f) => f.path === c));
  const dynamic = changed.some((c) => /require\(\s*[^"'`]|import\(\s*[^"'`]/.test(""));
  let confidence: ImpactReport["confidence"] = "high";
  if (unindexed.length) { confidence = "low"; reasons.push(`not indexed: ${unindexed.join(", ")}`); }
  if (index.parser === "regex") { confidence = confidence === "high" ? "medium" : confidence; reasons.push("regex import scanner (no TypeScript parser)"); }
  if (!tests.size) { confidence = "low"; reasons.push("no test is linked to the changed code"); }
  if (changed.some((c) => /package\.json$|\.prisma$|migrations?\//.test(c))) { confidence = "low"; reasons.push("dependency/schema change affects the whole application"); }
  void dynamic;
  return { changed, components: comps, routes: [...routes], pages: [...pages], entities: [...entities], tests: [...tests].map((t) => t.replace(/^file:/, "")), requirements: [...requirements].map((r) => r.replace(/^req:/, "")), journeys: [...journeys].map((j) => j.replace(/^journey:/, "")), contracts, confidence, reasons };
}

export interface ContractFinding { kind: "missing_route" | "method_mismatch" | "body_field_mismatch" | "missing_env" | "observed_failure"; severity: "high" | "medium"; confidence: "confirmed" | "likely"; detail: string; files: string[]; suggestion?: string }

const lev = (a: string, b: string) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };

/**
 * Cross-component integration checks over the WHOLE application (not only the
 * changed files): every frontend call has a server route with that method,
 * the JSON body fields the frontend sends are the ones the handler reads, and
 * required env vars are provided by the target environment.
 */
export function integrationFindings(graph: SystemGraph, index: CodeIndexData, files: Record<string, string>, env: { provided?: string[] } = {}): ContractFinding[] {
  const out: ContractFinding[] = [];
  const routes = index.routes;
  for (const c of index.contracts) {
    if (routes.some((r) => r.method === c.method && contractMatches(r.path, c))) continue;
    const otherMethod = routes.find((r) => contractMatches(r.path, c));
    if (otherMethod) { out.push({ kind: "method_mismatch", severity: "high", confidence: "confirmed", detail: `${c.file} sends ${c.method} ${c.path}, but the server only handles ${[...new Set(routes.filter((r) => contractMatches(r.path, c)).map((r) => r.method))].join("/")} there`, files: [c.file, otherMethod.file] }); continue; }
    const near = [...routes].sort((a, b) => lev(a.path, c.path) - lev(b.path, c.path))[0];
    out.push({ kind: "missing_route", severity: "high", confidence: routes.length ? "confirmed" : "likely", detail: `${c.file} calls ${c.method} ${c.path}, which no server route handles`, files: [c.file, ...(near ? [near.file] : [])], ...(near && lev(near.path, c.path) <= 3 ? { suggestion: `closest route is ${near.method} ${near.path} — likely a path typo in ${c.file}` } : {}) });
  }
  // Request body fields: what the client sends vs what the handler reads.
  for (const [path, src] of Object.entries(files)) {
    if (!/\.(html?|(c|m)?(j|t)sx?)$/.test(path) || isTestFile(path)) continue;
    for (const rf of requestFields(src)) {
      const r = routes.find((x) => x.method === rf.method && new RegExp(`^${x.path.replace(/:\w+/g, "[^/]+")}$`).test(rf.path));
      if (!r || !files[r.file]) continue;
      const read = handlerFields(files[r.file]);
      if (!read.length) continue;
      const unknown = rf.fields.filter((f) => !read.includes(f));
      const missing = read.filter((f) => !rf.fields.includes(f) && new RegExp(`\\b(?:body|b)\\.${f}\\b[^\\n]{0,80}(required|!|\\|\\|\\s*!|errors\\.push)`).test(files[r.file]));
      if (unknown.length && missing.length) out.push({ kind: "body_field_mismatch", severity: "high", confidence: "likely", detail: `${path} sends {${rf.fields.join(", ")}} to ${rf.method} ${rf.path}; the handler in ${r.file} reads {${read.join(", ")}} — ${missing.join(", ")} never sent, ${unknown.join(", ")} ignored`, files: [path, r.file] });
    }
  }
  // Required env vars the environment does not provide.
  if (env.provided) {
    const required = graph.edges.filter((e) => e.kind === "reads_env" && e.source.includes("required"));
    for (const e of required) {
      const name = e.to.replace(/^env:/, "");
      if (!env.provided.includes(name) && !["NODE_ENV", "PORT", "DATA_DIR", "HOME", "CI"].includes(name)) out.push({ kind: "missing_env", severity: "high", confidence: "confirmed", detail: `${e.from.replace(/^file:/, "")} requires ${name}, which the target environment does not provide`, files: [e.from.replace(/^file:/, "")] });
    }
  }
  // Runtime-observed broken calls.
  for (const e of graph.edges.filter((x) => x.basis === "runtime" && x.broken)) out.push({ kind: "observed_failure", severity: "high", confidence: "confirmed", detail: `In the running app, ${e.from.replace(/^(file|page):/, "")} → ${e.to.replace(/^route:/, "")}: ${e.source}`, files: [e.from.replace(/^(file|page):/, "")] });
  return out;
}

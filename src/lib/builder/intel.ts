/**
 * Codebase intelligence: a static index of one repository snapshot and the
 * change-impact analysis built on it.
 *
 *   files      language, size, top-level symbols, resolved local imports,
 *              external packages
 *   graph      import graph (local edges) + reverse graph
 *   tests      test file → every local file it transitively loads
 *   routes     HTTP routes (node-web route tables, Express-style calls,
 *              Next.js app-router route files)
 *   schema     data model files (Prisma models, SQL tables/migrations)
 *   config     package manager, scripts, dependencies, framework
 *   contracts  frontend `fetch("/api/…")` calls
 *
 * What it is and is not: imports are read with the TypeScript compiler's
 * pre-processor (`ts.preProcessFile`, which also detects `require()`), and
 * symbols from its parser, when the `typescript` package is installed;
 * otherwise a regex scanner is used and `parser` says so. There is no type
 * checking, no cross-file symbol resolution and no dynamic import tracing —
 * impact is file-level, which is what the analysis claims.
 */
import { prisma } from "@/lib/db";
import { detectProject } from "@/lib/factory/git";

export interface IndexedFile { path: string; lang: string; size: number; symbols: string[]; imports: string[]; external: string[]; unresolved: string[] }
export interface Route { method: string; path: string; file: string }
export interface CodeIndexData {
  version: 1;
  parser: "typescript" | "regex";
  files: IndexedFile[];
  tests: { file: string; covers: string[] }[];
  routes: Route[];
  schema: { file: string; kind: "prisma" | "sql"; entities: string[] }[];
  contracts: { file: string; method: string; path: string; open?: boolean }[];
  config: { language: string; framework: string | null; packageManager: string | null; testCommand: string | null; scripts: Record<string, string>; dependencies: Record<string, string> };
  limitations: string[];
}

const CODE = /\.(c|m)?(j|t)sx?$/;
const TEST = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.(c|m)?(j|t)sx?$/;
export const isTestFile = (p: string) => TEST.test(p) && CODE.test(p);
const langOf = (p: string) => (/\.tsx?$/.test(p) ? "typescript" : CODE.test(p) ? "javascript" : /\.prisma$/.test(p) ? "prisma" : /\.sql$/.test(p) ? "sql" : /\.json$/.test(p) ? "json" : /\.html?$/.test(p) ? "html" : /\.css$/.test(p) ? "css" : /\.md$/.test(p) ? "markdown" : "other");

type TS = typeof import("typescript");
let tsMod: TS | null | undefined;
async function loadTs(): Promise<TS | null> {
  if (tsMod !== undefined) return tsMod;
  try {
    const m = (await import("typescript")) as unknown as TS & { default?: TS };
    tsMod = (m.default ?? m) as TS;
  } catch {
    tsMod = null;
  }
  return tsMod;
}

function dirOf(p: string) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function join(base: string, rel: string) {
  const parts = (base ? base.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const s of parts) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

/** Resolve a relative specifier the way Node/TS would for a file in the snapshot. */
function resolveLocal(from: string, spec: string, all: Set<string>): string | null {
  const base = join(dirOf(from), spec);
  const candidates = [base, ...[".js", ".ts", ".tsx", ".jsx", ".cjs", ".mjs", ".json"].map((e) => base + e), ...["index.js", "index.ts", "index.tsx"].map((i) => `${base}/${i}`)];
  // TS sources often import "./x.js" for a "./x.ts" file.
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
  return candidates.find((c) => all.has(c)) ?? null;
}

function regexImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:import\s+(?:[^'"]*?\sfrom\s+)?|export\s+[^'"]*?\sfrom\s+|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

function regexSymbols(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm)) out.add(m[1]);
  return [...out];
}

function tsSymbols(ts: TS, path: string, src: string): string[] {
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, false, /\.tsx$|\.jsx$/.test(path) ? ts.ScriptKind.TSX : /\.tsx?$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const out = new Set<string>();
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) out.add(st.name.text);
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) { if (ts.isIdentifier(d.name)) out.add(d.name.text); }
    else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = st.expression.left.getText(sf);
      const m = left.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/);
      if (m) out.add(m[1]);
    }
  }
  return [...out];
}

function routesIn(path: string, src: string): Route[] {
  const out: Route[] = [];
  // node-web route tables: { method: "POST", pattern: /^\/api\/x$/ }
  for (const m of src.matchAll(/method:\s*["'](GET|POST|PUT|PATCH|DELETE)["']\s*,\s*(?:pattern|path):\s*(\/(?:\\\/|[^/\n])+\/|["'][^"']+["'])/g)) {
    const raw = m[2];
    const p = raw.startsWith("/") && raw.length > 2 && !/^["']/.test(raw) ? raw.slice(1, -1).replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/").replace(/\(\?<(\w+)>[^)]*\)/g, ":$1").replace(/\([^)]*\)/g, ":param") : raw.slice(1, -1);
    out.push({ method: m[1], path: p, file: path });
  }
  // Express / Fastify / router style: app.get("/x", …)
  for (const m of src.matchAll(/\b(?:app|router|server|fastify)\.(get|post|put|patch|delete)\(\s*["'`](\/[^"'`]*)["'`]/g)) out.push({ method: m[1].toUpperCase(), path: m[2], file: path });
  // Next.js app router: app/**/route.ts exporting HTTP verbs
  const next = path.match(/(?:^|\/)app\/(.*)\/route\.(t|j)sx?$/);
  if (next) {
    const urlPath = "/" + next[1].split("/").filter((s) => !/^\(.*\)$/.test(s)).map((s) => s.replace(/^\[(\.\.\.)?(.+)\]$/, ":$2")).join("/");
    for (const m of src.matchAll(/export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) out.push({ method: m[1], path: urlPath, file: path });
  }
  return out;
}

/**
 * Client → API calls: fetch() and common thin wrappers (api/request/apiFetch/http) with a string-literal
 * path. A literal followed by a query string or "+ expr" is a PREFIX (`open`): "/api/x/" + id matches
 * /api/x/:id, "/api/x" + "?q=…" matches /api/x.
 */
function contractsIn(path: string, src: string) {
  const out: { file: string; method: string; path: string; open?: boolean }[] = [];
  const re = /\b(?:fetch|api|request|apiFetch|http)\(\s*["'`](\/api\/[^"'`?$]*)(\?[^"'`]*)?["'`]((?:\s*\+\s*(?:[^,()]|\([^()]*\))+)?)(?:\s*,\s*\{[^}]*?method:\s*["'](\w+)["'])?/g;
  for (const m of src.matchAll(re)) out.push({ file: path, method: (m[4] ?? "GET").toUpperCase(), path: m[1], ...(m[2] || m[3].trim() ? { open: true } : {}) });
  return out;
}

/** Does a client call (possibly a prefix) hit a server route path (with :params)? */
export function contractMatches(routePath: string, c: { path: string; open?: boolean }) {
  const re = new RegExp(`^${routePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^/]+")}$`);
  if (re.test(c.path)) return true;
  if (!c.open) return false;
  if (c.path.endsWith("/")) return routePath.startsWith(c.path) && routePath.length > c.path.length; // "/api/x/" + id
  return re.test(c.path) || routePath === c.path; // query appended
}

function schemaIn(path: string, src: string) {
  if (/\.prisma$/.test(path)) return { file: path, kind: "prisma" as const, entities: [...src.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]) };
  if (/\.sql$/.test(path)) return { file: path, kind: "sql" as const, entities: [...src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?(\w+)/gi)].map((m) => m[1]) };
  return null;
}

/** Build the index from file contents (pure apart from loading the parser). */
export async function buildIndex(files: Record<string, string>): Promise<CodeIndexData> {
  const ts = await loadTs();
  const all = new Set(Object.keys(files));
  const indexed: IndexedFile[] = [];
  const routes: Route[] = [];
  const contracts: CodeIndexData["contracts"] = [];
  const schema: CodeIndexData["schema"] = [];
  for (const [path, src] of Object.entries(files)) {
    const lang = langOf(path);
    const f: IndexedFile = { path, lang, size: src.length, symbols: [], imports: [], external: [], unresolved: [] };
    if (CODE.test(path)) {
      const specs = ts ? ts.preProcessFile(src, true, true).importedFiles.map((x) => x.fileName) : regexImports(src);
      for (const s of new Set(specs)) {
        if (s.startsWith(".")) {
          const r = resolveLocal(path, s, all);
          if (r) f.imports.push(r);
          else f.unresolved.push(s);
        } else if (!s.startsWith("node:")) f.external.push(s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);
      }
      try {
        f.symbols = ts ? tsSymbols(ts, path, src) : regexSymbols(src);
      } catch {
        f.symbols = regexSymbols(src);
      }
      routes.push(...routesIn(path, src));
    }
    if (/\.(html?|(c|m)?(j|t)sx?)$/.test(path) && !isTestFile(path)) contracts.push(...contractsIn(path, src));
    const sc = schemaIn(path, src);
    if (sc) schema.push(sc);
    f.external = [...new Set(f.external)];
    indexed.push(f);
  }
  indexed.sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(indexed.map((f) => [f.path, f]));
  const closure = (start: string) => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const p = stack.pop()!;
      for (const d of byPath.get(p)?.imports ?? []) if (!seen.has(d)) { seen.add(d); stack.push(d); }
    }
    return [...seen].sort();
  };
  const tests = indexed.filter((f) => isTestFile(f.path)).map((f) => ({ file: f.path, covers: closure(f.path) }));
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = files["package.json"] ? JSON.parse(files["package.json"]) : {};
  } catch {
    /* recorded by detectProject as unknown */
  }
  const det = detectProject(files);
  const limitations = [
    ts ? "Imports and symbols read with the TypeScript parser; no type checking or cross-file symbol resolution." : "TypeScript is not installed on this server: imports and symbols were read with a regex scanner (less precise).",
    "Impact is file-level through static imports; dynamic imports, string-built paths and runtime registration are not traced.",
  ];
  return {
    version: 1,
    parser: ts ? "typescript" : "regex",
    files: indexed,
    tests,
    routes,
    schema,
    contracts,
    config: { language: det.language, framework: det.framework, packageManager: det.packageManager, testCommand: det.testCommand, scripts: pkg.scripts ?? {}, dependencies: { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } },
    limitations,
  };
}

/** Every file that (transitively) imports one of `paths`. */
export function dependentsOf(index: CodeIndexData, paths: string[]): string[] {
  const rev = new Map<string, string[]>();
  for (const f of index.files) for (const d of f.imports) rev.set(d, [...(rev.get(d) ?? []), f.path]);
  const seen = new Set<string>();
  const stack = [...paths];
  while (stack.length) {
    const p = stack.pop()!;
    for (const u of rev.get(p) ?? []) if (!seen.has(u)) { seen.add(u); stack.push(u); }
  }
  for (const p of paths) seen.delete(p);
  return [...seen].sort();
}

/** Tests that exercise any of `paths` (directly, transitively, or by being one of them). */
export function testsFor(index: CodeIndexData, paths: string[]): string[] {
  const set = new Set(paths);
  return index.tests.filter((t) => set.has(t.file) || t.covers.some((c) => set.has(c))).map((t) => t.file).sort();
}

/**
 * Files, tests and routes lexically related to a piece of text (a requirement
 * or task). This is keyword matching against paths, symbols and routes — it is
 * labelled as such wherever it is used.
 */
export function relatedToText(index: CodeIndexData, text: string, limit = 8) {
  const STOP = new Set(["users", "user", "with", "that", "from", "this", "have", "they", "their", "when", "able", "should", "must", "into", "page", "data", "list", "view", "each", "only", "than", "then", "also"]);
  const terms = [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3 && !STOP.has(t)))].map((t) => t.replace(/(ies|es|s)$/, ""));
  const score = (hay: string) => terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
  const files = index.files
    .filter((f) => CODE.test(f.path) || f.lang === "html")
    .map((f) => ({ path: f.path, score: score(`${f.path} ${f.symbols.join(" ")}`.toLowerCase()) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((x) => x.path);
  return { method: "lexical" as const, terms, files, tests: testsFor(index, files), routes: index.routes.filter((r) => files.includes(r.file) || score(r.path.toLowerCase()) > 0) };
}

/**
 * Context selection strategies for an engineering task (which files the
 * engineer is shown with content). Versioned so the lab can compare them on
 * the same benchmarks; `lexical` is the original behaviour.
 */
export const CONTEXT_STRATEGIES = ["lexical", "graph"] as const;
// Adopted 2026-10-23 from lab experiment "context-graph" (recall 0.5 → 1 train + held-out, precision 0.50 → 0.69, context 1.1k → 2.1k chars).
export const DEFAULT_CONTEXT_STRATEGY = "graph";
/**
 * lexical  keyword overlap with paths + top-level symbols (original)
 * graph    lexical seeds, plus: files serving an HTTP route the task names
 *          ("POST /api/users"), then the import-graph neighbourhood — the
 *          tests that load each seed — so the engineer sees how the code is
 *          verified. Seeds are ranked first; tests fill the remaining slots.
 */
export function contextFiles(index: CodeIndexData, text: string, strategy: string = DEFAULT_CONTEXT_STRATEGY, limit = 6): { strategy: string; files: string[] } {
  const lex = relatedToText(index, text, limit);
  if (strategy !== "graph") return { strategy: "lexical", files: lex.files.slice(0, limit) };
  const named = [...text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)?\s*(\/api\/[A-Za-z0-9_/:{}-]+)/g)].map((m) => ({ method: m[1]?.toUpperCase(), path: m[2].replace(/\/$/, "") }));
  const routeFiles = index.routes.filter((r) => named.some((n) => n.path === r.path && (!n.method || n.method === r.method))).map((r) => r.file);
  // Wiring files (routers that only register routes) rank below the modules that implement behaviour.
  const seeds = [...new Set([...routeFiles, ...lex.files.filter((f) => !isTestFile(f))])];
  const tests = [...new Set([...lex.files.filter(isTestFile), ...seeds.flatMap((f) => index.tests.filter((t) => t.covers.includes(f)).sort((a, b) => a.covers.length - b.covers.length).map((t) => t.file))])];
  const files = [...seeds.slice(0, Math.max(1, limit - Math.min(tests.length, Math.ceil(limit / 2)))), ...tests].filter((f, i, a) => a.indexOf(f) === i).slice(0, limit);
  return { strategy: "graph", files };
}

export interface ImpactFlag {
  kind: "api_breaking" | "deleted_still_imported" | "migration" | "dependency" | "coverage_gap" | "authorization" | "unintended_file" | "contract_mismatch" | "test_weakened" | "lockfile";
  severity: "low" | "medium" | "high";
  /** confirmed = a static fact that will break something; warning = needs a person or reviewer to judge. */
  confidence: "confirmed" | "warning";
  detail: string;
  files: string[];
}
export interface Impact {
  changed: string[];
  dependents: string[];
  tests: string[];
  routes: Route[];
  flags: ImpactFlag[];
  parser: CodeIndexData["parser"];
  limitations: string[];
}

const countOf = (src: string | undefined, re: RegExp) => (src ? (src.match(re) ?? []).length : 0);
const ASSERT = /\bassert(?:\.\w+)?\s*\(|\bexpect\s*\(/g;
const CASES = /\b(?:test|it)\s*\(\s*["'`]/g;
const major = (v: string | undefined) => Number((v ?? "").replace(/^[^\d]*/, "").split(".")[0] || NaN);

/**
 * Change impact between two snapshots. `scope` = files the task declared it
 * would touch (used only for the "unintended file" warning). `protectedTests`
 * = test files that existed on the base branch (weakening one is a high
 * warning for review: it may be justified by a requirement change).
 * `failingTests` = test files that were FAILING in the previous attempt:
 * weakening one of those is confirmed — it hides the defect instead of fixing it.
 */
export function analyzeChange(args: {
  before: CodeIndexData; after: CodeIndexData;
  beforeFiles: Record<string, string>; afterFiles: Record<string, string>;
  changed: { status: string; path: string }[]; scope?: string[]; protectedTests?: string[]; failingTests?: string[];
}): Impact {
  const { before, after } = args;
  const changed = args.changed.map((c) => c.path);
  const deleted = args.changed.filter((c) => c.status.startsWith("D")).map((c) => c.path);
  const flags: ImpactFlag[] = [];
  const dependents = [...new Set([...dependentsOf(after, changed), ...dependentsOf(before, deleted)])].filter((p) => !changed.includes(p)).sort();
  const tests = testsFor(after, [...changed, ...dependents]);

  // Routes that existed before and are gone now (same file set or anywhere).
  const key = (r: Route) => `${r.method} ${r.path}`;
  const afterRoutes = new Set(after.routes.map(key));
  for (const r of before.routes) if (!afterRoutes.has(key(r))) flags.push({ kind: "api_breaking", severity: "high", confidence: "warning", detail: `Route ${key(r)} (${r.file}) no longer exists — existing clients would break unless the requirement removes it`, files: [r.file] });

  for (const d of deleted) {
    const users = after.files.filter((f) => f.imports.includes(d) || f.unresolved.some((u) => resolveLocalLoose(f.path, u) === d));
    if (users.length) flags.push({ kind: "deleted_still_imported", severity: "high", confidence: "confirmed", detail: `${d} was deleted but is still imported by ${users.map((u) => u.path).join(", ")}`, files: [d, ...users.map((u) => u.path)] });
  }
  for (const f of after.files) for (const u of f.unresolved) if (changed.includes(f.path)) flags.push({ kind: "deleted_still_imported", severity: "high", confidence: "confirmed", detail: `${f.path} imports ${u}, which does not exist in the repository`, files: [f.path] });

  const schemaChanged = changed.filter((p) => /\.prisma$|(^|\/)migrations?\/|\.sql$/.test(p));
  if (schemaChanged.length) flags.push({ kind: "migration", severity: "high", confidence: "warning", detail: `Data model changed (${schemaChanged.join(", ")}): check that existing data migrates and that a rollback path exists`, files: schemaChanged });

  const bd = before.config.dependencies, ad = after.config.dependencies;
  const added = Object.keys(ad).filter((k) => !(k in bd));
  const removed = Object.keys(bd).filter((k) => !(k in ad));
  const bumped = Object.keys(ad).filter((k) => k in bd && bd[k] !== ad[k]);
  if (added.length || removed.length || bumped.length) {
    const majors = bumped.filter((k) => Number.isFinite(major(bd[k])) && major(ad[k]) > major(bd[k]));
    flags.push({ kind: "dependency", severity: majors.length || removed.length ? "high" : "medium", confidence: "warning", detail: [added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : "", bumped.length ? `changed ${bumped.map((k) => `${k} ${bd[k]} → ${ad[k]}`).join(", ")}${majors.length ? ` (major: ${majors.join(", ")})` : ""}` : ""].filter(Boolean).join("; "), files: ["package.json"] });
    const stillUsed = removed.filter((r) => after.files.some((f) => f.external.includes(r)));
    if (stillUsed.length) flags.push({ kind: "dependency", severity: "high", confidence: "confirmed", detail: `Removed dependencies are still imported: ${stillUsed.join(", ")}`, files: after.files.filter((f) => f.external.some((e) => stillUsed.includes(e))).map((f) => f.path) });
  }
  if (changed.some((p) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p)) && !changed.includes("package.json")) flags.push({ kind: "lockfile", severity: "medium", confidence: "warning", detail: "Lockfile changed without a package.json change", files: changed.filter((p) => /lock/.test(p)) });

  const src = changed.filter((p) => CODE.test(p) && !isTestFile(p) && !deleted.includes(p) && !/^scripts\//.test(p));
  const uncovered = src.filter((p) => !testsFor(after, [p]).length);
  if (uncovered.length) flags.push({ kind: "coverage_gap", severity: "medium", confidence: "warning", detail: `No test loads ${uncovered.join(", ")} — changed behaviour there is not exercised`, files: uncovered });

  const auth = changed.filter((p) => /auth|session|permission|authz|middleware|login|password|token|acl|role/i.test(p));
  if (auth.length) flags.push({ kind: "authorization", severity: "high", confidence: "warning", detail: `Security-sensitive files changed (${auth.join(", ")}): review for authorization regressions`, files: auth });

  if (args.scope?.length) {
    const scopeDirs = args.scope.map((s) => dirOf(s));
    const outside = changed.filter((p) => !isTestFile(p) && !args.scope!.includes(p) && !scopeDirs.some((d) => d && p.startsWith(`${d}/`)) && !["package.json", "package-lock.json", "README.md"].includes(p));
    if (outside.length) flags.push({ kind: "unintended_file", severity: "low", confidence: "warning", detail: `Changed outside the task's declared files: ${outside.join(", ")}`, files: outside });
  }

  if (after.routes.length) {
    for (const c of after.contracts) {
      if (!changed.includes(c.file) && !after.routes.some((r) => changed.includes(r.file))) continue;
      if (!after.routes.some((r) => r.method === c.method && contractMatches(r.path, c))) flags.push({ kind: "contract_mismatch", severity: "high", confidence: "warning", detail: `${c.file} calls ${c.method} ${c.path}, which no server route handles`, files: [c.file] });
    }
  }

  for (const p of changed.filter(isTestFile)) {
    const b = args.beforeFiles[p], a = args.afterFiles[p];
    if (b === undefined) continue;
    const lostAsserts = countOf(b, ASSERT) - countOf(a, ASSERT);
    const lostCases = countOf(b, CASES) - countOf(a, CASES);
    if (a === undefined || lostAsserts > 0 || lostCases > 0 || /\.(skip|todo)\s*\(|\{\s*skip:\s*true/.test(a ?? "") && !/\.(skip|todo)\s*\(|\{\s*skip:\s*true/.test(b)) {
      const prot = args.protectedTests?.includes(p) ?? false;
      const hiding = args.failingTests?.includes(p) ?? false;
      flags.push({ kind: "test_weakened", severity: prot || hiding ? "high" : "medium", confidence: hiding ? "confirmed" : "warning", detail: `${p}: ${a === undefined ? "deleted" : `${Math.max(lostCases, 0)} test case(s) and ${Math.max(lostAsserts, 0)} assertion(s) removed or tests skipped`}${hiding ? " — this test was failing in the previous attempt; weakening it hides the defect instead of fixing it" : prot ? " — this test existed before the task; a reviewer must confirm the requirement justifies it" : ""}`, files: [p] });
    }
  }
  return { changed, dependents, tests, routes: after.routes.filter((r) => changed.includes(r.file) || dependents.includes(r.file)), flags, parser: after.parser, limitations: after.limitations };
}

function resolveLocalLoose(from: string, spec: string) {
  const base = join(dirOf(from), spec);
  return /\.\w+$/.test(base) ? base : `${base}.js`;
}

/**
 * A focused test command for the impacted tests, when the project's test
 * runner can take file arguments safely (node:test). Null otherwise — the
 * full suite still runs as the gate.
 */
export function focusedTestCommand(index: CodeIndexData, tests: string[]): string | null {
  const t = index.config.scripts.test ?? "";
  if (!/^node --test\b/.test(t) || !tests.length || tests.length > 20) return null;
  const safe = tests.filter((f) => /^[A-Za-z0-9_./-]+$/.test(f));
  return safe.length === tests.length ? `node --test ${safe.join(" ")}` : null;
}

/** Persisted index for one commit of a repo (built once per sha). */
export async function indexSnapshot(companyId: string, repoId: string, sha: string, files: Record<string, string>) {
  const hit = await prisma.codeIndex.findUnique({ where: { repoId_sha: { repoId, sha } } });
  if (hit && hit.companyId === companyId) return JSON.parse(hit.data) as CodeIndexData;
  const data = await buildIndex(files);
  await prisma.codeIndex.upsert({ where: { repoId_sha: { repoId, sha } }, create: { companyId, repoId, sha, data: JSON.stringify(data), files: data.files.length }, update: {} }).catch(() => null);
  // Keep the index current but bounded: the latest 20 snapshots per repository.
  const old = await prisma.codeIndex.findMany({ where: { repoId, companyId }, orderBy: { createdAt: "desc" }, skip: 20, select: { id: true } });
  if (old.length) await prisma.codeIndex.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  return data;
}

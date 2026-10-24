/**
 * Cross-component failure investigation (AURA V13). Pure and deterministic:
 * given the recorded evidence of a failed attempt and the system graph, it
 *
 *   1. locates every symptom in the graph (failing test → files it covers,
 *      browser request → page + route, contract finding → both ends)
 *   2. generates COMPETING hypotheses (one per plausible origin component)
 *   3. scores each by evidence: how many symptoms it explains, whether the
 *      evidence is direct (command output names it, a runtime request failed)
 *      or only structural (graph proximity), and whether it is upstream of
 *      the others (the original cause, not a secondary error)
 *   4. returns them ranked with the explained/unexplained symptoms, the
 *      smallest corrective change, targeted diagnostics to run, and
 *      the "ambiguous" flag when the top two are not separated by evidence
 *
 * Infrastructure origins (missing env, unreachable external host, sandbox)
 * are reported as limitations with NO code fix — AURA must not rewrite
 * application code to hide unavailable infrastructure.
 */
import type { SystemGraph, ContractFinding } from "./graph";

export interface Symptom { id: string; kind: "test" | "browser" | "contract" | "command" | "env"; detail: string; files: string[]; direct: boolean }
export interface Hypothesis {
  id: string;
  origin: string; // component id in the graph
  category: "frontend_defect" | "backend_defect" | "contract_mismatch" | "data_persistence" | "configuration" | "external_service" | "infrastructure" | "test_defect" | "unknown";
  statement: string;
  explains: string[]; // symptom ids
  unexplained: string[];
  score: number;
  evidence: string[];
  fix: { kind: "code" | "config" | "none"; files: string[]; change: string };
  diagnostics: string[];
}
export interface Diagnosis { symptoms: Symptom[]; hypotheses: Hypothesis[]; rootCause: Hypothesis | null; ambiguous: boolean; infrastructure: boolean; summary: string }

const near = (graph: SystemGraph, file: string) => {
  const fid = `file:${file}`;
  return new Set([fid, ...graph.edges.filter((e) => e.from === fid || e.to === fid).flatMap((e) => [e.from, e.to])]);
};

export function diagnose(input: {
  graph: SystemGraph;
  contracts: ContractFinding[];
  defects: { signature: string; category: string; title: string; files: string[]; failingTests: string[]; output: string }[];
  browser?: { findings: { kind: string; route: string; detail: string }[]; requests?: { method: string; path: string; status: number }[] } | null;
  changed: string[];
  envProvided?: string[];
}): Diagnosis {
  const { graph } = input;
  const symptoms: Symptom[] = [];
  input.defects.forEach((d, i) => symptoms.push({ id: `S${i + 1}`, kind: "test", detail: d.title, files: d.files, direct: d.failingTests.length > 0 }));
  input.browser?.findings.forEach((f, i) => symptoms.push({ id: `B${i + 1}`, kind: "browser", detail: `${f.kind} ${f.route}: ${f.detail}`.slice(0, 300), files: [], direct: true }));
  input.contracts.forEach((c, i) => symptoms.push({ id: `C${i + 1}`, kind: c.kind === "missing_env" ? "env" : "contract", detail: c.detail, files: c.files, direct: c.confidence === "confirmed" }));

  const hyps: Hypothesis[] = [];
  const add = (h: Omit<Hypothesis, "id" | "unexplained" | "score"> & { weight: number }) => {
    const unexplained = symptoms.filter((s) => !h.explains.includes(s.id)).map((s) => s.id);
    const direct = symptoms.filter((s) => h.explains.includes(s.id) && s.direct).length;
    // Evidence-based score: explained symptoms (direct ones count double) + origin weight − unexplained.
    const score = h.explains.length + direct + h.weight - unexplained.length * 0.25;
    hyps.push({ ...h, id: `H${hyps.length + 1}`, unexplained, score: Math.round(score * 100) / 100 });
  };

  // H: missing configuration (env) — the upstream cause of backend + frontend + test failures.
  for (const c of input.contracts.filter((x) => x.kind === "missing_env")) {
    const name = c.detail.match(/requires (\w+)/)?.[1] ?? "?";
    const file = c.files[0];
    const related = new Set([...near(graph, file)]);
    const explains = symptoms.filter((s) => s.kind === "env" && s.detail.includes(name) || s.files.some((f) => related.has(`file:${f}`)) || /500|internal error|ECONNREFUSED|undefined/i.test(s.detail) || new RegExp(name).test(s.detail)).map((s) => s.id);
    add({ origin: `env:${name}`, category: "configuration", statement: `${name} is not configured; ${file} cannot work without it, and the errors downstream are consequences`, explains, evidence: [c.detail], fix: { kind: "config", files: [], change: `provide ${name} in the target environment (Settings → Secrets) — no code change` }, diagnostics: [`check the environment for ${name}`, `run the failing test with ${name} set`], weight: 3 });
  }
  // H: external service unavailable (connection errors to a known external host).
  const extErr = input.defects.filter((d) => /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|getaddrinfo|fetch failed|socket hang up|503 Service Unavailable/i.test(d.output));
  if (extErr.length) {
    const hosts = graph.nodes.filter((n) => n.kind === "external").map((n) => n.label);
    const named = hosts.filter((h) => extErr.some((d) => d.output.includes(h)));
    add({ origin: named.length ? `external:${named[0]}` : "external:?", category: "external_service", statement: `An external dependency${named.length ? ` (${named.join(", ")})` : ""} is unreachable from the run environment; the application code is not the cause`, explains: symptoms.filter((s) => extErr.some((d) => d.title === s.detail)).map((s) => s.id), evidence: extErr.map((d) => (d.output.match(/(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|getaddrinfo[^\n]*|fetch failed|503[^\n]*)/)?.[0] ?? "connection error").slice(0, 160)), fix: { kind: "none", files: [], change: "report the unavailable infrastructure; retry when it is reachable, or verify against a test double (labelled as such)" }, diagnostics: ["check network access / credentials for the provider", "re-run when the service is reachable"], weight: 3 });
  }
  // H: frontend↔backend contract mismatch.
  for (const c of input.contracts.filter((x) => ["missing_route", "method_mismatch", "body_field_mismatch"].includes(x.kind))) {
    const [client, server] = c.files;
    const explains = symptoms.filter((s) => s.detail === c.detail || s.kind === "browser" && /journey|request|404|405|400|not refreshed|never displayed/.test(s.detail) || s.files.some((f) => f === client || f === server)).map((s) => s.id);
    const clientChanged = input.changed.includes(client), serverChanged = server ? input.changed.includes(server) : false;
    // Fix the side that changed in this attempt (the other side is the established contract).
    const fixFile = serverChanged && !clientChanged ? server : client;
    add({ origin: `file:${fixFile}`, category: "contract_mismatch", statement: `${c.detail}${c.suggestion ? ` (${c.suggestion})` : ""}`, explains, evidence: [c.detail], fix: { kind: "code", files: [fixFile], change: c.suggestion ?? `align ${fixFile} with the ${clientChanged && !serverChanged ? "existing server" : "client"} contract` }, diagnostics: [`call ${c.detail.match(/(GET|POST|PUT|PATCH|DELETE) \S+/)?.[0] ?? "the endpoint"} directly and compare request/response`], weight: c.confidence === "confirmed" ? 2.5 : 1 });
  }
  // H: runtime request failures from the browser (server errors on a route).
  for (const q of (input.browser?.requests ?? []).filter((r) => r.status >= 500)) {
    const route = graph.edges.find((e) => e.kind === "handles" && e.to.startsWith(`route:${q.method} `) && new RegExp(`^${e.to.slice(`route:${q.method} `.length).replace(/:\w+/g, "[^/]+")}$`).test(q.path));
    const file = route?.from.replace(/^file:/, "");
    add({ origin: file ? `file:${file}` : `route:${q.method} ${q.path}`, category: "backend_defect", statement: `${q.method} ${q.path} returned ${q.status} in the running app${file ? ` (handler ${file})` : ""}`, explains: symptoms.filter((s) => s.kind === "browser" || (file && s.files.includes(file))).map((s) => s.id), evidence: [`browser request ${q.method} ${q.path} → ${q.status}`], fix: { kind: "code", files: file ? [file] : [], change: "fix the handler error (see server log)" }, diagnostics: [`curl the route; read the server log for the stack trace`], weight: 2 });
  }
  // H: per-file code defects (the failing tests' covered files), preferring files changed in this attempt.
  const byFile = new Map<string, string[]>();
  for (const d of input.defects) for (const f of d.files.filter((x) => !/\.test\./.test(x))) byFile.set(f, [...(byFile.get(f) ?? []), symptoms.find((s) => s.detail === d.title)!.id]);
  for (const [file, ids] of byFile) {
    const kind = graph.nodes.find((n) => n.id === `file:${file}`)?.kind;
    const backend = graph.edges.some((e) => e.kind === "handles" && e.from === `file:${file}`) || graph.edges.some((e) => e.kind === "persists" && e.from === `file:${file}`);
    add({ origin: `file:${file}`, category: kind === "page" ? "frontend_defect" : graph.edges.some((e) => e.kind === "persists" && e.from === `file:${file}`) ? "data_persistence" : backend ? "backend_defect" : "frontend_defect", statement: `${file} does not behave as its tests expect`, explains: ids, evidence: input.defects.filter((d) => d.files.includes(file)).map((d) => d.title), fix: { kind: "code", files: [file], change: `fix ${file} (code under test), not the test` }, diagnostics: [`run the failing test(s) alone`, `read ${file} at the failing line`], weight: input.changed.includes(file) ? 1.5 : 0.5 });
  }
  // H: the test itself is wrong (only plausible when only test files changed).
  if (input.defects.length && input.changed.length && input.changed.every((c) => /\.test\./.test(c))) add({ origin: `file:${input.changed[0]}`, category: "test_defect", statement: "Only tests changed in this attempt; the new test may assert the wrong behaviour", explains: symptoms.filter((s) => s.kind === "test").map((s) => s.id), evidence: ["no source file changed"], fix: { kind: "code", files: input.changed, change: "re-check the expected values against the requirement" }, diagnostics: ["compare the assertion with the acceptance criterion"], weight: 0.5 });

  const ranked = hyps.sort((a, b) => b.score - a.score);
  const top = ranked[0] ?? null;
  const ambiguous = !!top && ranked.length > 1 && ranked[1].score >= top.score - 0.5 && ranked[1].origin !== top.origin;
  const infrastructure = !!top && ["configuration", "external_service", "infrastructure"].includes(top.category) && !ambiguous;
  const summary = !top ? "No hypothesis is supported by the recorded evidence (cause unknown)." : ambiguous ? `Ambiguous: ${top.statement} — or — ${ranked[1].statement}. Run: ${[...top.diagnostics, ...ranked[1].diagnostics].slice(0, 3).join("; ")}` : `${top.statement}. Explains ${top.explains.length}/${symptoms.length} symptom(s)${top.unexplained.length ? `; unexplained: ${top.unexplained.join(", ")}` : ""}.`;
  return { symptoms, hypotheses: ranked, rootCause: ambiguous ? null : top, ambiguous, infrastructure, summary };
}

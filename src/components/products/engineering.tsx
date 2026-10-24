"use client";

/**
 * Product control-centre panels for the engineering record: delivery quality
 * gate + report, defects, project memory, and the code map / impact view.
 * Every panel renders persisted state from the API and labels what is
 * estimated, assumed or not verified.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, XCircle, AlertTriangle, FileText } from "lucide-react";
import { useQuery, fetchJSON } from "@/hooks/useApi";
import { Skeleton, Badge } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { timeAgo } from "@/lib/utils";
import { ScorecardPanel } from "./delivery";

type Ev = { kind: string; ref: string; detail: string };
interface GateCriterion { id: string; label: string; status: "passed" | "failed" | "blocked" | "not_verified"; required: boolean; detail: string; evidence: Ev[] }
interface Gate { scorecard?: Record<string, { value: number | null; numerator: number; denominator: number; unit: string; formula: string; unavailable?: string }>; deployment?: { url: string | null; env: string } | null; profile: string; profileLabel: string; profileDescription: string; criteria: GateCriterion[]; summary: { passed: number; failed: number; blocked: number; notVerified: number; requiredOpen: string[] }; implemented: boolean; approvedForRelease: boolean; deployed: boolean; note: string; profiles: { key: string; label: string; description: string }[] }
interface Defect { id: string; itemKey: string; buildId: string; title: string; category: string; command: string; exitCode: number | null; commandRunId: string; failingTests: string[]; files: string[]; diagnosis: string; status: string; occurrences: number; fixedByCommandRunId: string | null; createdAt: string }
interface Memory { id: string; key: string; kind: string; content: string; status: string; files: string[]; requirements: string[]; provenance: { type: string; ref: string; detail: string }; staleReason: string; uses: number; verifiedAt: string | null; updatedAt: string }
interface Intel { branch: string; sha: string; parser: string; limitations: string[]; config: { language: string; framework: string | null; testCommand: string | null }; files: { path: string; lang: string; symbols: number; imports: number; external: string[] }[]; routes: { method: string; path: string; file: string }[]; tests: { file: string; covers: string[] }[]; schema: { file: string; kind: string; entities: string[] }[]; item: null | { key: string; related: { method: string; files: string[]; tests: string[] }; impact: Impact | null } }
export interface Impact { changed?: string[]; dependents?: string[]; tests?: string[]; flags?: { kind: string; severity: string; confidence: string; detail: string; files: string[] }[]; parser?: string }

const GATE_ICON: Record<string, React.ReactNode> = { passed: <CheckCircle2 className="h-3.5 w-3.5 text-success" />, failed: <XCircle className="h-3.5 w-3.5 text-danger" />, blocked: <AlertTriangle className="h-3.5 w-3.5 text-warning" />, not_verified: <CircleDashed className="h-3.5 w-3.5 text-text-faint" /> };
const tone = (s: string) => (["passed", "VERIFIED", "FIXED"].includes(s) ? "success" : ["failed", "RECURRING", "INVALIDATED"].includes(s) ? "danger" : ["blocked", "OPEN", "STALE"].includes(s) ? "warning" : "neutral");

function useRefresh(version: number, ...fns: (() => void)[]) {
  useEffect(() => {
    if (version > 0) fns.forEach((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
}

export function GateTab({ base, canAct, isAdmin, version }: { base: string; canAct: boolean; isAdmin: boolean; version: number }) {
  const { toast } = useApp();
  const { data: g, error, refetch } = useQuery<Gate>(`${base}/gate`, 15000);
  const [report, setReport] = useState<any>(null);
  useRefresh(version, refetch);
  if (error) return <p className="text-sm text-danger">Could not load the quality gate: {error}. The last loaded state may be stale.</p>;
  if (!g) return <Skeleton className="h-60" />;
  async function setProfile(profile: string) {
    try {
      await fetchJSON(`${base}/gate`, { method: "PATCH", body: JSON.stringify({ profile }) });
      refetch();
    } catch (e) {
      toast({ title: "Profile not changed", description: (e as Error).message, level: "danger" });
    }
  }
  async function generate() {
    try {
      setReport(await fetchJSON(`${base}/gate`, { method: "POST", body: JSON.stringify({ action: "report" }) }));
    } catch (e) {
      toast({ title: "Report failed", description: (e as Error).message, level: "danger" });
    }
  }
  return (
    <div className="space-y-5" data-testid="gate" data-implemented={g.implemented}>
      <section className="grid gap-3 sm:grid-cols-3">
        {[
          ["Implemented", g.implemented, "every required criterion passed"],
          ["Approved for release", g.approvedForRelease, "a person approved the release candidate"],
          ["Deployed", g.deployed, g.deployment ? `${g.deployment.env} at ${g.deployment.url}` : "the current release is not deployed + verified"],
        ].map(([label, ok, help]) => (
          <div key={label as string} className="rounded-lg border border-border p-3" data-state={label as string}>
            <div className="metric-label">{label as string}</div>
            <div className="mt-1 flex items-center gap-1.5 text-sm font-medium">{ok ? <CheckCircle2 className="h-4 w-4 text-success" /> : <CircleDashed className="h-4 w-4 text-text-faint" />}{ok ? "Yes" : "Not yet"}</div>
            <p className="mt-0.5 text-2xs text-text-faint">{help as string}</p>
          </div>
        ))}
      </section>
      <p className="text-xs text-text-muted" role="status">{g.note}</p>
      <ScorecardPanel metrics={g.scorecard} />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="metric-label" htmlFor="gate-profile">Quality profile</label>
        <select id="gate-profile" className="input h-8 w-auto text-xs" value={g.profile} disabled={!isAdmin} onChange={(e) => setProfile(e.target.value)} title={isAdmin ? "" : "Admins choose what 'done' means for this product"}>
          {g.profiles.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <span className="text-text-faint">{g.profileDescription}</span>
        <span className="mono ml-auto text-2xs text-text-faint">{g.summary.passed} passed · {g.summary.failed} failed · {g.summary.blocked} blocked · {g.summary.notVerified} not verified</span>
      </div>
      <ul className="divide-y divide-border-subtle rounded-lg border border-border text-sm">
        {g.criteria.map((c) => (
          <li key={c.id} className="px-3 py-2" data-criterion={c.id} data-status={c.status}>
            <div className="flex items-start gap-2">{GATE_ICON[c.status]}<span className="w-72 shrink-0">{c.label}{c.required ? "" : <span className="ml-1 text-2xs text-text-faint">(not required)</span>}</span><span className="text-xs text-text-muted">{c.status.replace("_", " ")} — {c.detail}</span></div>
            {c.evidence.length > 0 && <details className="ml-6 mt-1 text-2xs text-text-faint"><summary className="cursor-pointer">Evidence ({c.evidence.length})</summary><ul className="mt-1 space-y-0.5">{c.evidence.map((e, i) => <li key={i}><span className="mono">{e.kind}</span> {e.detail}</li>)}</ul></details>}
          </li>
        ))}
      </ul>
      {canAct && <button onClick={generate} className="btn-secondary btn-sm" data-testid="generate-report"><FileText className="h-3 w-3" /> Generate delivery report</button>}
      {report && (
        <section className="rounded-lg border border-border p-3 text-xs" data-testid="delivery-report">
          <h3 className="text-sm font-medium">Delivery report {report.version} — {report.conclusion.implemented ? "implemented" : "not complete"}</h3>
          <p className="mt-1 text-text-muted">{report.conclusion.note}</p>
          <p className="mono mt-2 text-2xs">{report.tasks.length} task(s) · {report.commits.length} git operation(s) · defects {report.defects.fixed} fixed / {report.defects.open} open / {report.defects.abandoned} abandoned · {report.usage.runs} run(s) · est. ${report.usage.estimatedCostUsd.toFixed(4)} of ${report.usage.budgetUsd} budget</p>
          <p className="mt-1 text-2xs text-text-faint">{report.usage.costNote}</p>
        </section>
      )}
    </div>
  );
}

export function DefectsTab({ base, version, openRun }: { base: string; version: number; openRun: (id: string) => void }) {
  const { data, error, refetch } = useQuery<Defect[]>(`${base}/defects`, 15000);
  useRefresh(version, refetch);
  if (error) return <p className="text-sm text-danger">Could not load defects: {error}</p>;
  if (!data) return <Skeleton className="h-40" />;
  if (!data.length) return <p className="text-sm text-text-muted">No defects recorded. Defects are created only from failed checks the engine actually ran.</p>;
  return (
    <ul className="space-y-2 text-sm" data-testid="defects">
      {data.map((d) => (
        <li key={d.id} className="rounded-lg border border-border p-3" data-defect={d.status}>
          <div className="flex flex-wrap items-center gap-2"><span className="mono text-2xs text-text-faint">{d.itemKey}</span><span className="font-medium">{d.title}</span><Badge tone={tone(d.status)}>{d.status.toLowerCase()}</Badge><Badge tone="neutral">{d.category.replace("_", " ")}</Badge><span className="ml-auto text-2xs text-text-faint">seen {d.occurrences}× · {timeAgo(d.createdAt)}</span></div>
          <p className="mt-1 text-xs text-text-muted">{d.diagnosis}</p>
          <p className="mono mt-1 text-2xs">$ {d.command} → exit {d.exitCode ?? "?"}{d.failingTests.length ? ` · failing: ${d.failingTests.join("; ")}` : ""}</p>
          {d.files.length > 0 && <p className="mono mt-0.5 text-2xs text-text-faint">files: {d.files.join(", ")}</p>}
          <button onClick={() => openRun(d.buildId)} className="mt-1 text-2xs underline">Open the run{d.fixedByCommandRunId ? " (fix proven by a passing check)" : ""}</button>
        </li>
      ))}
    </ul>
  );
}

export function MemoryTab({ base, canAct, isAdmin, version }: { base: string; canAct: boolean; isAdmin: boolean; version: number }) {
  const { toast } = useApp();
  const { data, error, refetch } = useQuery<Memory[]>(`${base}/memory`, 30000);
  useRefresh(version, refetch);
  if (error) return <p className="text-sm text-danger">Could not load project memory: {error}</p>;
  if (!data) return <Skeleton className="h-40" />;
  async function set(m: Memory, status: "VERIFIED" | "INVALIDATED") {
    const note = status === "INVALIDATED" ? window.prompt("Why is this no longer true?") ?? "" : "";
    try {
      await fetchJSON(`${base}/memory`, { method: "PATCH", body: JSON.stringify({ memoryId: m.id, status, note }) });
      refetch();
    } catch (e) {
      toast({ title: "Memory not updated", description: (e as Error).message, level: "danger" });
    }
  }
  if (!data.length) return <p className="text-sm text-text-muted">No project memory yet. Facts are learned only from verified runs and approvals; brief assumptions are kept as assumptions.</p>;
  const groups = ["VERIFIED", "ASSUMPTION", "STALE", "INVALIDATED"];
  return (
    <div className="space-y-4" data-testid="memory">
      <p className="text-xs text-text-muted">Agents receive only the verified facts and labelled assumptions relevant to their task. Stale and invalidated entries are never used.</p>
      {groups.map((g) => {
        const rows = data.filter((m) => m.status === g);
        if (!rows.length) return null;
        return (
          <section key={g}>
            <div className="metric-label mb-1">{g.toLowerCase()} ({rows.length})</div>
            <ul className="divide-y divide-border-subtle rounded-lg border border-border text-xs">
              {rows.map((m) => (
                <li key={m.id} className="px-3 py-2" data-memory={m.key} data-status={m.status}>
                  <div className="flex items-start gap-2"><Badge tone={tone(m.status)}>{m.kind.replace("_", " ")}</Badge><span className="min-w-0 flex-1">{m.content}</span>
                    {canAct && m.status !== "INVALIDATED" && <button onClick={() => set(m, "INVALIDATED")} className="btn-ghost btn-sm">Invalidate</button>}
                    {isAdmin && m.status !== "VERIFIED" && <button onClick={() => set(m, "VERIFIED")} className="btn-ghost btn-sm">Confirm</button>}
                  </div>
                  <p className="mono mt-0.5 text-2xs text-text-faint">{m.provenance.type} {m.provenance.detail}{m.staleReason ? ` · ${m.staleReason}` : ""} · used {m.uses}× · {timeAgo(m.updatedAt)}</p>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function ImpactView({ impact }: { impact: Impact | null | undefined }) {
  if (!impact?.changed) return null;
  const flags = impact.flags ?? [];
  return (
    <section data-testid="impact">
      <div className="metric-label mb-1">Change impact ({impact.parser} parser, file-level)</div>
      <p className="mono text-2xs text-text-muted">dependents: {impact.dependents?.join(", ") || "none"} · tests run first: {impact.tests?.join(", ") || "none"}</p>
      {flags.length > 0 ? <ul className="mt-1 space-y-0.5 text-xs">{flags.map((f, i) => <li key={i}><Badge tone={f.confidence === "confirmed" ? "danger" : "warning"}>{f.confidence} · {f.severity}</Badge> <span className="font-medium">{f.kind.replace(/_/g, " ")}</span> <span className="text-text-muted">{f.detail}</span></li>)}</ul> : <p className="text-xs text-text-muted">No regression risks flagged by static analysis.</p>}
    </section>
  );
}

export function CodeTab({ base, item }: { base: string; item: string | null }) {
  const { data, error } = useQuery<Intel>(`${base}/intel${item ? `?item=${encodeURIComponent(item)}` : ""}`);
  if (error) return <p className="text-sm text-danger">Could not index the repository: {error}</p>;
  if (!data) return <Skeleton className="h-40" />;
  return (
    <div className="space-y-4 text-sm" data-testid="code-map">
      <p className="text-xs text-text-muted">Index of <span className="mono">{data.branch} @ {data.sha.slice(0, 8)}</span> · {data.config.language}{data.config.framework ? ` · ${data.config.framework}` : ""} · tests: <span className="mono">{data.config.testCommand ?? "none"}</span></p>
      <ul className="list-disc pl-4 text-2xs text-text-faint">{data.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
      {data.item && (
        <section className="rounded-lg border border-border p-3">
          <div className="metric-label mb-1">Related to {data.item.key} ({data.item.related.method} match)</div>
          <p className="mono text-2xs">files: {data.item.related.files.join(", ") || "none found"}</p>
          <p className="mono text-2xs">tests: {data.item.related.tests.join(", ") || "none"}</p>
          <div className="mt-2"><ImpactView impact={data.item.impact} /></div>
        </section>
      )}
      <section><div className="metric-label mb-1">API routes ({data.routes.length})</div><ul className="mono text-2xs">{data.routes.map((r) => <li key={`${r.method} ${r.path}`}>{r.method} {r.path} <span className="text-text-faint">→ {r.file}</span></li>)}</ul></section>
      <section><div className="metric-label mb-1">Tests ({data.tests.length})</div><ul className="mono text-2xs">{data.tests.map((t) => <li key={t.file}>{t.file} <span className="text-text-faint">loads {t.covers.length} file(s)</span></li>)}</ul></section>
      {data.schema.length > 0 && <section><div className="metric-label mb-1">Data model</div><ul className="mono text-2xs">{data.schema.map((s) => <li key={s.file}>{s.file}: {s.entities.join(", ")}</li>)}</ul></section>}
      <details><summary className="metric-label cursor-pointer">Files ({data.files.length})</summary><ul className="mono mt-1 text-2xs">{data.files.map((f) => <li key={f.path}>{f.path} <span className="text-text-faint">{f.lang} · {f.symbols} symbols · {f.imports} imports{f.external.length ? ` · ${f.external.join(", ")}` : ""}</span></li>)}</ul></details>
    </div>
  );
}

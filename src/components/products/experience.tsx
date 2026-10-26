"use client";

/**
 * Product experience (V17) tab. Everything shown is a persisted audit or
 * finding: methods that actually ran (and what did not), journeys with
 * step-level observations, findings with evidence/priority/policy, metrics
 * with their formula and source, regressions vs the previous audit, and the
 * limitations of automated checks. Buttons call backend actions that enforce
 * roles and the risk policy; the UI only hides what the role cannot do.
 */
import { useMemo, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { useQuery, fetchJSON } from "@/hooks/useApi";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { timeAgo } from "@/lib/utils";

type Tone = "success" | "warning" | "danger" | "neutral" | "info";
const SEV: Record<string, Tone> = { critical: "danger", high: "danger", medium: "warning", low: "neutral" };
const STATUS: Record<string, Tone> = { OPEN: "warning", REOPENED: "danger", IN_PROGRESS: "info", FIXED: "success", ACCEPTED_RISK: "neutral", DISMISSED: "neutral" };
const J: Record<string, Tone> = { passed: "success", failed: "danger", not_run: "warning" };
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();

interface Metric { id: string; label: string; value: number | null; of: number | null; source: string; formula: string }
interface Journey { id: string; name: string; requirements: string[]; critical: boolean; status: string; detail: string; steps: { action: string; expect: string; observed: string; ok: boolean | null }[] }
interface Audit { id: string; status: string; trigger: string; sha: string; createdAt: string; finishedAt: string | null; error: string; methods: Record<string, string>; routes: { route: string; viewport: string; httpStatus: number | null; screenshot: number | null }[]; journeys: Journey[]; score: { metrics?: Metric[]; criticalFailures?: string[]; verdict?: string; fixed?: number; reopened?: number }; limitations: string[]; baselineId: string | null; regressions: string[] }
interface Finding { id: string; fingerprint: string; dimension: string; rule: string; title: string; detail: string; route: string; viewport: string; target: string; files: string[]; requirements: string[]; journey: string; severity: string; confidence: string; method: string; impact: string; recommendation: string; evidence: { kind: string; ref: string; detail: string }[]; priority: { score: number; why: string } | null; manualCheck: boolean; status: string; reopened: number; itemKey: string | null; item: { key: string; status: string } | null; attempts: number; policy: { mode: string; why: string }; history: { at: string; change: string }[] }
interface Data { audits: Audit[]; latest: Audit | null; findings: Finding[] }

const VERDICT: Record<string, [Tone, string]> = {
  blocked: ["danger", "Blocked — a critical journey or critical problem fails"],
  issues: ["warning", "Usable with high-severity issues"],
  no_blocking_issues: ["success", "No blocking issues found by the automated checks"],
  unverified: ["warning", "Unverified — no browser session ran"],
};

export function ExperienceTab({ base, canAct, isAdmin }: { base: string; canAct: boolean; isAdmin: boolean }) {
  const { data, error, refetch } = useQuery<Data>(`${base}/experience`, 8000);
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [dim, setDim] = useState("all");
  const [show, setShow] = useState<"active" | "all">("active");
  const [open, setOpen] = useState<string | null>(null);
  const act = async (key: string, url: string, body: unknown, done: string) => {
    setBusy(key);
    try {
      await fetchJSON(url, { method: "POST", body: JSON.stringify(body) });
      toast({ title: done, level: "success" });
      refetch();
    } catch (e) {
      toast({ title: "Not done", description: (e as Error).message, level: "danger" });
    } finally {
      setBusy(null);
    }
  };
  const findings = useMemo(() => (data?.findings ?? []).filter((f) => (show === "all" || ["OPEN", "REOPENED", "IN_PROGRESS"].includes(f.status)) && (dim === "all" || f.dimension === dim)).sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0)), [data, dim, show]);
  if (error) return <p className="text-sm text-danger">Experience view unavailable: {error}</p>;
  if (!data) return <Skeleton className="h-60" />;
  const running = data.audits.find((a) => a.status === "QUEUED" || a.status === "RUNNING");
  const l = data.latest;
  const v = l?.score.verdict ? VERDICT[l.score.verdict] : null;
  const dims = [...new Set(data.findings.map((f) => f.dimension))];
  return (
    <div className="space-y-5" data-testid="experience">
      <div className="flex flex-wrap items-center gap-3">
        {canAct && <button className="btn btn-primary" disabled={!!running || busy === "audit"} onClick={() => act("audit", `${base}/experience`, {}, "Experience audit queued")}>{running || busy === "audit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{running ? `Audit ${running.status.toLowerCase()}…` : "Run experience audit"}</button>}
        {l ? <span className="text-xs text-text-muted">Latest audit of {l.sha.slice(0, 8)} · {timeAgo(l.finishedAt ?? l.createdAt)} · trigger {l.trigger}</span> : <span className="text-xs text-text-muted">No completed audit yet. An audit runs the product in an isolated container and inspects it in a real browser; nothing is shown until one has run.</span>}
        {data.audits[0]?.status === "FAILED" && <Badge tone="danger">last audit failed: {data.audits[0].error.slice(0, 120)}</Badge>}
      </div>

      {l && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {v && <Badge tone={v[0]}>{v[1]}</Badge>}
            {(l.score.criticalFailures ?? []).length > 0 && <span className="text-xs text-danger">Critical: {(l.score.criticalFailures ?? []).map(label).join(", ")}</span>}
            {l.regressions.length > 0 && <Badge tone="danger">{l.regressions.length} regression(s) vs the previous audit</Badge>}
            {(l.score.fixed ?? 0) > 0 && <Badge tone="success">{l.score.fixed} fixed since the previous audit</Badge>}
            {(l.score.reopened ?? 0) > 0 && <Badge tone="danger">{l.score.reopened} reopened after a fix</Badge>}
          </div>
          <p className="text-xs text-text-muted">Methods: {Object.entries(l.methods).map(([k, s]) => `${k} ${s}`).join(" · ")}</p>
          <table className="w-full text-xs" data-testid="experience-metrics">
            <thead className="text-left text-text-muted"><tr><th className="py-1">Measure</th><th>Value</th><th>How it is calculated</th><th>Source</th></tr></thead>
            <tbody>{(l.score.metrics ?? []).map((m) => (
              <tr key={m.id} className="border-t border-border-subtle"><td className="py-1">{m.label}</td><td className="mono">{m.value === null ? "not measured" : m.of !== null ? `${m.value} / ${m.of}` : m.value}</td><td className="text-text-muted">{m.formula}</td><td className="text-text-faint">{m.source}</td></tr>
            ))}</tbody>
          </table>
        </section>
      )}

      {l && l.journeys.length > 0 && (
        <section>
          <div className="metric-label mb-1">User journeys (from the brief's requirements and the app's API)</div>
          <ul className="space-y-1.5">{l.journeys.map((j) => (
            <li key={j.id} className="rounded-md border border-border p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2"><Badge tone={J[j.status] ?? "neutral"}>{label(j.status)}</Badge>{j.critical && <Badge tone="info">critical</Badge>}<span className="font-medium">{j.name}</span>{j.requirements.length > 0 && <span className="text-2xs text-text-faint">{j.requirements.join(", ")}</span>}</div>
              <p className="mt-0.5 text-xs text-text-muted">{j.detail}</p>
              {j.steps.length > 0 && <ol className="mt-1 list-decimal pl-5 text-xs">{j.steps.map((s, i) => <li key={i} className={s.ok === false ? "text-danger" : ""}>{s.action} — expected {s.expect || "—"}; observed <span className="mono">{s.observed}</span>{s.ok === null ? " (could not check)" : ""}</li>)}</ol>}
            </li>
          ))}</ul>
        </section>
      )}

      <section>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="metric-label">Findings ({findings.length})</span>
          <select className="input h-7 w-auto text-xs" aria-label="Filter by dimension" value={dim} onChange={(e) => setDim(e.target.value)}><option value="all">all dimensions</option>{dims.map((d) => <option key={d} value={d}>{label(d)}</option>)}</select>
          <select className="input h-7 w-auto text-xs" aria-label="Filter by status" value={show} onChange={(e) => setShow(e.target.value as "active" | "all")}><option value="active">open + in progress</option><option value="all">all, including fixed</option></select>
        </div>
        {findings.length ? <ul className="space-y-1.5">{findings.map((f) => (
          <li key={f.id} className="rounded-md border border-border p-2.5 text-sm" data-testid="experience-finding">
            <button className="flex w-full flex-wrap items-center gap-2 text-left" aria-expanded={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)}>
              <Badge tone={SEV[f.severity] ?? "neutral"}>{f.severity}</Badge>
              <Badge tone={STATUS[f.status] ?? "neutral"}>{label(f.status)}{f.reopened ? ` ×${f.reopened}` : ""}</Badge>
              <span className="font-medium">{f.title}</span>
              <span className="text-2xs text-text-faint">{label(f.dimension)} · {f.confidence} · {f.method}{f.route ? ` · ${f.route}` : ""}{f.viewport ? ` @ ${f.viewport}` : ""}</span>
            </button>
            {open === f.id && (
              <div className="mt-2 space-y-1.5 text-xs">
                <p>{f.detail}</p>
                <p><span className="font-medium">User impact:</span> {f.impact}</p>
                <p><span className="font-medium">Recommended fix:</span> {f.recommendation}</p>
                {f.target && <p><span className="font-medium">Element:</span> <span className="mono">{f.target}</span></p>}
                {f.files.length > 0 && <p><span className="font-medium">Files:</span> <span className="mono">{f.files.join(", ")}</span></p>}
                {f.requirements.length > 0 && <p><span className="font-medium">Requirements:</span> {f.requirements.join(", ")}{f.journey ? ` · journey ${f.journey}` : ""}</p>}
                <ul className="list-disc pl-5 text-text-muted">{f.evidence.map((e, i) => <li key={i}><span className="mono">[{e.kind}] {e.ref}</span> {e.detail}</li>)}</ul>
                {f.priority && <p className="text-text-faint">Priority {f.priority.score}: {f.priority.why}</p>}
                <p className="text-text-faint">Change policy: {f.policy.mode} — {f.policy.why}{f.manualCheck ? " · also needs a manual / assistive-technology check" : ""}</p>
                {f.item && <p>Task <span className="mono">{f.item.key}</span>: {label(f.item.status)}{f.attempts ? ` (attempt ${f.attempts})` : ""}</p>}
                <details><summary className="cursor-pointer text-text-muted">History ({f.history.length})</summary><ul className="mt-1 space-y-0.5">{f.history.map((h, i) => <li key={i}>{timeAgo(h.at)} — {h.change}</li>)}</ul></details>
                <div className="flex flex-wrap gap-2 pt-1">
                  {canAct && ["OPEN", "REOPENED"].includes(f.status) && f.policy.mode !== "recommend" && (f.policy.mode === "auto" || isAdmin) && <button className="btn btn-primary" disabled={busy === f.id} onClick={() => act(f.id, `${base}/experience/findings/${f.id}`, { action: "create_task" }, "Task created in the backlog")}>{busy === f.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Create fix task</button>}
                  {f.policy.mode === "approval" && !isAdmin && <span className="text-text-faint">An admin must approve this change.</span>}
                  {isAdmin && ["OPEN", "REOPENED"].includes(f.status) && f.severity !== "critical" && <>
                    <button className="btn" disabled={busy === f.id} onClick={() => act(f.id, `${base}/experience/findings/${f.id}`, { action: "accept_risk", note: "" }, "Marked as accepted risk")}>Accept risk</button>
                    <button className="btn" disabled={busy === f.id} onClick={() => act(f.id, `${base}/experience/findings/${f.id}`, { action: "dismiss", note: "" }, "Dismissed")}>Dismiss</button>
                  </>}
                  {canAct && ["ACCEPTED_RISK", "DISMISSED"].includes(f.status) && <button className="btn" onClick={() => act(f.id, `${base}/experience/findings/${f.id}`, { action: "reopen", note: "" }, "Reopened")}>Reopen</button>}
                </div>
              </div>
            )}
          </li>
        ))}</ul> : <p className="text-xs text-text-muted">{l ? "No findings match this filter." : "Run an audit to collect findings."}</p>}
      </section>

      {l && l.routes.some((r) => r.screenshot !== null) && (
        <details className="text-xs"><summary className="cursor-pointer text-text-muted">Screenshots ({l.routes.filter((r) => r.screenshot !== null).length}) — visual record only; findings come from interaction and DOM checks</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">{l.routes.filter((r) => r.screenshot !== null).map((r) => (
            // eslint-disable-next-line @next/next/no-img-element
            <figure key={`${r.route}-${r.viewport}`}><img src={`${base}/experience?audit=${l.id}&screenshot=${r.screenshot}`} alt={`${r.route} at ${r.viewport}`} className="max-h-72 rounded border border-border object-contain" loading="lazy" /><figcaption className="text-text-faint">{r.route} @ {r.viewport} · HTTP {r.httpStatus ?? "—"}</figcaption></figure>
          ))}</div>
        </details>
      )}

      {l && <section><div className="metric-label mb-1">Limitations of this audit</div><ul className="list-disc space-y-0.5 pl-5 text-xs text-text-muted">{l.limitations.map((x, i) => <li key={i}>{x}</li>)}</ul></section>}
    </div>
  );
}

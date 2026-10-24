"use client";

/**
 * Engineering Lab: AURA's own improvement process, from persisted records only
 * (/api/companies/[id]/lab). Nothing here animates or implies a controller is
 * running: the loop status is whatever the database says, verified against
 * the experiment rows on every load.
 */
import { use, useState } from "react";
import { CheckCircle2, CircleDashed, XCircle, Pause, Play, Square } from "lucide-react";
import { useQuery, fetchJSON } from "@/hooks/useApi";
import { PageHeader, Skeleton, Badge, ErrorState } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { timeAgo } from "@/lib/utils";

type Metric = { value: number | null; numerator: number; denominator: number; formula: string };
type Card = { dimensions: Record<string, Record<string, Metric>>; criticalFailures: string[]; notMeasured: { dimension: string; reason: string }[] };
interface Run { id: string; suiteVersion: string; split: string; configKey: string; executor: string; label: string; status: string; total: number; passed: number; failed: number; errored: number; skipped: number; durationMs: number; metrics: { all?: Card; train?: Card; heldout?: Card }; experimentId: string | null; startedAt: string; error: string }
interface Experiment { id: string; key: string; title: string; problem: string; hypothesis: string; status: string; evidence: { kind: string; ref: string; detail: string }[]; successCriteria: { metric: string; op: string; value: number; split: string }[]; regressionCriteria: { metric: string; op: string; value: number; split: string }[]; baselineConfig: string; candidateConfig: string; decision: { outcome?: string; reasons?: string[]; changedCases?: { id: string; split: string; baseline: string; candidate: string }[]; approval?: { by: string; decision: string } }; createdAt: string; finishedAt: string | null }
interface Overview { state: { status: string; objective: string; activeExperimentId: string | null; activeConfig: string; backlog: { key: string; risk: string; evidence: { detail: string }[]; previouslyRejected: boolean }[]; blockers: string[]; nextAction: string; resume: string; lastVerifiedAt: string | null }; suiteVersion: string; executor: { kind: string | null; reason: string }; runs: Run[]; experiments: Experiment[]; verification: string[]; role?: string }

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = { ACCEPTED: "success", REJECTED: "danger", INCONCLUSIVE: "neutral", AWAITING_APPROVAL: "warning", RUNNING: "info", PROPOSED: "neutral", CANCELLED: "neutral", INTERRUPTED: "warning" };
const pct = (m?: Metric) => (!m || m.value == null ? "not measured" : `${Math.round(m.value * 1000) / 10}% (${Number(m.numerator.toFixed(2))}/${m.denominator})`);

export default function EngineeringLab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const base = `/api/companies/${id}/lab`;
  const { toast } = useApp();
  const { data, error, refetch } = useQuery<Overview>(base, 15000);
  const [busy, setBusy] = useState<string | null>(null);
  async function act(label: string, url: string, body: unknown) {
    setBusy(label);
    try {
      await fetchJSON(url, { method: "POST", body: JSON.stringify(body) });
      toast({ title: label, level: "success" });
      refetch();
    } catch (e) {
      toast({ title: `${label} failed`, description: (e as Error).message, level: "danger" });
    } finally {
      setBusy(null);
    }
  }
  if (error) return <div className="page"><ErrorState message={`Lab unavailable: ${error}`} onRetry={refetch} /></div>;
  if (!data) return <div className="page"><Skeleton className="h-80" /></div>;
  const st = data.state;
  const latest = data.runs.find((r) => r.status === "COMPLETED" && r.configKey === st.activeConfig) ?? data.runs.find((r) => r.status === "COMPLETED");
  const card = latest?.metrics;
  return (
    <div className="page space-y-6" data-testid="engineering-lab">
      <PageHeader title="Engineering Lab" description="Benchmarks of AURA's own engineering pipeline and the experiments that change it. Every number below is a persisted measurement." />
      <section className="grid gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-border p-3" data-testid="loop-status" data-status={st.status}><div className="metric-label">Loop status (persisted)</div><div className="mt-1 text-sm font-medium">{st.status.toLowerCase()}</div><p className="text-2xs text-text-faint">{st.lastVerifiedAt ? `verified ${timeAgo(st.lastVerifiedAt)}` : "never verified"} · no background controller runs unless the job worker is started</p></div>
        <div className="rounded-lg border border-border p-3"><div className="metric-label">Active configuration</div><div className="mono mt-1 text-sm">{st.activeConfig}</div></div>
        <div className="rounded-lg border border-border p-3"><div className="metric-label">Executor</div><div className="mono mt-1 text-sm">{data.executor.kind ?? "none"}</div><p className="text-2xs text-text-faint">{data.executor.reason}</p></div>
        <div className="rounded-lg border border-border p-3"><div className="metric-label">Next recommended action</div><p className="mt-1 text-xs">{st.nextAction || "—"}</p></div>
      </section>
      {data.verification.length > 0 && <p className="text-xs text-warning" role="status">State reconciled on load: {data.verification.join("; ")}</p>}
      {st.blockers.length > 0 && <p className="text-xs text-danger" role="status">Blockers: {st.blockers.join("; ")}</p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary btn-sm" disabled={!!busy} onClick={() => act("Benchmark run finished", `${base}/runs`, { config: st.activeConfig, split: "all" })}>Run benchmarks ({st.activeConfig})</button>
        <button className="btn-ghost btn-sm" disabled={!!busy} onClick={() => act("Backlog refreshed", base, { action: "backlog" })}>Refresh backlog from evidence</button>
        {st.status === "PAUSED" ? <button className="btn-ghost btn-sm" onClick={() => act("Loop resumed", base, { action: "resume" })}><Play className="h-3 w-3" /> Resume loop</button> : <button className="btn-ghost btn-sm" onClick={() => act("Loop paused", base, { action: "pause" })}><Pause className="h-3 w-3" /> Pause loop</button>}
      </div>

      {card?.all && (
        <section data-testid="scorecard">
          <h2 className="mb-1 text-sm font-medium">Scorecard — run {latest!.id.slice(-6)} · suite {latest!.suiteVersion} · {latest!.executor} · {timeAgo(latest!.startedAt)}</h2>
          {card.all.criticalFailures.length > 0 && <p className="mb-2 text-xs text-danger" data-testid="critical-failures">Critical: defective changes accepted — {card.all.criticalFailures.join(", ")}</p>}
          <div className="overflow-x-auto"><table className="table text-xs"><thead><tr><th>Dimension</th><th>Metric</th><th>Train</th><th>Held-out</th></tr></thead><tbody>
            {Object.entries(card.all.dimensions).flatMap(([dim, ms]) => Object.entries(ms).map(([k, m]) => (
              <tr key={`${dim}.${k}`} data-metric={`${dim}.${k}`}><td>{dim}</td><td title={m.formula}>{k}</td><td className="mono">{dim === "economics" && !k.endsWith("Rate") ? (card.train?.dimensions[dim][k].value ?? "—").toString().slice(0, 8) : pct(card.train?.dimensions[dim][k])}</td><td className="mono">{dim === "economics" && !k.endsWith("Rate") ? (card.heldout?.dimensions[dim][k].value ?? "—").toString().slice(0, 8) : pct(card.heldout?.dimensions[dim][k])}</td></tr>
            )))}
          </tbody></table></div>
          <ul className="mt-1 text-2xs text-text-faint">{card.all.notMeasured.map((n) => <li key={n.dimension}>Not measured — {n.dimension}: {n.reason}</li>)}</ul>
        </section>
      )}

      <section>
        <h2 className="mb-1 text-sm font-medium">Improvement backlog (from failing benchmarks)</h2>
        {!st.backlog.length ? <p className="text-xs text-text-muted">Empty. Refresh after a benchmark run.</p> : <ul className="space-y-1 text-xs" data-testid="backlog">{st.backlog.map((b) => <li key={b.key}><Badge tone={b.risk === "critical" ? "danger" : b.risk === "high" ? "warning" : "neutral"}>{b.risk}</Badge> <span className="mono">{b.key}</span> — {b.evidence.length} failing case(s){b.previouslyRejected ? " · an approach for this was rejected before" : ""}</li>)}</ul>}
      </section>

      <section>
        <h2 className="mb-1 text-sm font-medium">Experiments</h2>
        {!data.experiments.length ? <p className="text-xs text-text-muted">No experiments yet.</p> : (
          <ul className="space-y-2" data-testid="experiments">{data.experiments.map((e) => (
            <li key={e.id} className="rounded-lg border border-border p-3 text-xs" data-experiment={e.key} data-status={e.status}>
              <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{e.title}</span><Badge tone={STATUS_TONE[e.status] ?? "neutral"}>{e.status.toLowerCase().replace("_", " ")}</Badge><span className="mono text-text-faint">{e.baselineConfig} → {e.candidateConfig}</span><span className="ml-auto text-text-faint">{timeAgo(e.createdAt)}</span></div>
              <p className="mt-1 text-text-muted"><strong>Problem:</strong> {e.problem}</p>
              <p className="text-text-muted"><strong>Hypothesis:</strong> {e.hypothesis}</p>
              <p className="mono mt-1 text-2xs">success: {e.successCriteria.map((c) => `${c.split} ${c.metric} ${c.op} ${c.value}`).join(" · ")}{e.regressionCriteria.length ? ` | regression: ${e.regressionCriteria.map((c) => `${c.split} ${c.metric} ${c.op} ${c.value}`).join(" · ")}` : ""}</p>
              {e.decision.reasons && <ul className="mt-1 space-y-0.5">{e.decision.reasons.map((r, i) => <li key={i} className="flex gap-1">{/^success.*: met\)/.test(r) ? <CheckCircle2 className="h-3 w-3 text-success" /> : /^regression|falsely|dropped/.test(r) ? <XCircle className="h-3 w-3 text-danger" /> : <CircleDashed className="h-3 w-3 text-text-faint" />}<span>{r}</span></li>)}</ul>}
              {e.decision.changedCases && e.decision.changedCases.length > 0 && <p className="mono mt-1 text-2xs text-text-faint">changed cases: {e.decision.changedCases.map((c) => `${c.id} ${c.baseline}→${c.candidate}`).join(", ")}</p>}
              {e.decision.approval && <p className="mt-1 text-2xs">Decided by {e.decision.approval.by}: {e.decision.approval.decision}</p>}
              <div className="mt-2 flex gap-2">
                {["PROPOSED", "INTERRUPTED"].includes(e.status) && <button className="btn-secondary btn-sm" onClick={() => act("Experiment queued", `${base}/experiments/${e.id}`, { action: "start" })}>Run experiment</button>}
                {["PROPOSED", "RUNNING", "INTERRUPTED"].includes(e.status) && <button className="btn-ghost btn-sm" onClick={() => act("Experiment cancelled", `${base}/experiments/${e.id}`, { action: "cancel" })}><Square className="h-3 w-3" /> Cancel</button>}
                {e.status === "AWAITING_APPROVAL" && <><button className="btn-primary btn-sm" data-testid="approve-experiment" onClick={() => act("Experiment approved", `${base}/experiments/${e.id}`, { action: "approve" })}>Approve</button><button className="btn-ghost btn-sm" onClick={() => act("Experiment rejected", `${base}/experiments/${e.id}`, { action: "reject" })}>Reject</button></>}
              </div>
            </li>
          ))}</ul>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-sm font-medium">Recent benchmark runs</h2>
        <ul className="mono space-y-0.5 text-2xs" data-testid="runs">{data.runs.map((r) => <li key={r.id}>{timeAgo(r.startedAt)} · {r.label} · {r.configKey} · {r.split} · {r.executor} · {r.status.toLowerCase()} · {r.passed}/{r.total} passed{r.errored ? ` · ${r.errored} errored` : ""} · {(r.durationMs / 1000).toFixed(1)} s{r.error ? ` · ${r.error}` : ""}</li>)}</ul>
      </section>
      <p className="text-2xs text-text-faint">{st.resume}</p>
    </div>
  );
}

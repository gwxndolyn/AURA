"use client";

import { Fragment, use, useState } from "react";
import { FlaskConical, Gauge, GitCompare, Cpu, AlertTriangle, BookOpen, ShieldCheck } from "lucide-react";
import { useQuery, useMutation } from "@/hooks/useApi";
import { Card, Badge, EmptyState, Skeleton, PageHeader } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { cn, formatPercent, timeAgo } from "@/lib/utils";

/**
 * AI Engineering Intelligence workspace. Every value shown is read from
 * persisted evaluation/run/prompt records via /api/companies/[id]/intelligence/*.
 * Metrics with no data render as "—" with the sample size, never as 0% / 100%.
 */

type Metric = { value: number | null; numerator: number; denominator: number; formula: string; unit?: string };

const TABS = [
  { key: "overview", label: "Overview", icon: Gauge },
  { key: "scorecards", label: "Agent scorecards", icon: ShieldCheck },
  { key: "prompts", label: "Prompt lab", icon: GitCompare },
  { key: "models", label: "Model lab", icon: Cpu },
  { key: "failures", label: "Failure analysis", icon: AlertTriangle },
  { key: "knowledge", label: "Knowledge review", icon: BookOpen },
] as const;
type Tab = (typeof TABS)[number]["key"];

function pct(v: number | null | undefined) {
  return v == null ? "—" : formatPercent(v * 100, 0);
}
function usd(v: number | null | undefined) {
  return v == null ? "—" : `$${v < 0.01 ? v.toFixed(5) : v.toFixed(3)}`;
}
function ms(v: number | null | undefined) {
  return v == null ? "—" : `${Math.round(v)}ms`;
}

function MetricCell({ m, fmt = pct }: { m: Metric; fmt?: (v: number | null) => string }) {
  return (
    <span title={`${m.formula} = ${m.numerator.toFixed?.(4) ?? m.numerator} / ${m.denominator}`} className={cn("mono", m.value == null && "text-text-faint")}>
      {fmt(m.value)}
      <span className="text-text-faint text-2xs ml-1">n={m.denominator}</span>
    </span>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <div className="metric-label">{label}</div>
      <div className="mono mt-1 text-lg">{value}</div>
      {sub && <div className="mt-0.5 text-2xs text-text-faint">{sub}</div>}
    </div>
  );
}

export default function IntelligencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tab, setTab] = useState<Tab>("overview");
  const base = `/api/companies/${id}/intelligence`;

  return (
    <div className="page">
      <PageHeader
        title="AI Evaluation"
        description="Versioned evaluations of agents, prompts and models. Every figure is read from persisted evaluation records; metrics without data show “—” with their sample size."
      />
      <div className="tabs mb-5" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} data-active={tab === t.key} onClick={() => setTab(t.key)} className="tab">
            <t.icon className="h-3.5 w-3.5" /> {t.label}
          </button>
        ))}
      </div>
      {tab === "overview" && <OverviewTab base={base} />}
      {tab === "scorecards" && <ScorecardsTab base={base} />}
      {tab === "prompts" && <PromptsTab base={base} />}
      {tab === "models" && <ModelsTab base={base} />}
      {tab === "failures" && <FailuresTab base={base} />}
      {tab === "knowledge" && <KnowledgeTab base={base} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
interface OverviewData {
  evaluations: number; liveEvaluations: number; fixtureEvaluations: number; casesEvaluated: number;
  passRate: number | null; failedCases: number; activePromptVersions: number; costPerSuccessfulCase: number | null;
  latencyP50: number | null; latencyP95: number | null; latencyNote: string;
  production: { agentRuns: number; completed: number; costPerCompletedRun: number | null; runsWithRecordedPromptVersion: number };
  collaboration: { handoffs: number; bugReports: number; reworkPerHandoff: number | null; decisionsRecorded: number };
}

function OverviewTab({ base }: { base: string }) {
  const { data, loading, refetch } = useQuery<OverviewData>(`${base}/overview`, 10000);
  const { data: evals } = useQuery<{ id: string; agentKey: string; datasetId: string; datasetVersion: string; promptKey: string; promptVersion: number; mode: string; label: string; status: string; passed: number; total: number; skipped: number; cost: number; startedAt: string }[]>(`${base}/evaluations`, 10000);
  if (loading && !data) return <Skeleton className="h-40" />;
  if (!data) return null;
  return (
    <div className="space-y-5">
      <RunEvaluationForm base={base} onDone={refetch} />
      {data.evaluations === 0 ? (
        <Card>
          <EmptyState icon={FlaskConical} title="No evaluations yet" description="Run an evaluation above to start collecting evidence. Nothing on this page is estimated." />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="Evaluations" value={`${data.evaluations}`} sub={`${data.liveEvaluations} live · ${data.fixtureEvaluations} fixture (simulator)`} />
            <Kpi label="Case pass rate" value={pct(data.passRate)} sub={`${data.casesEvaluated - data.failedCases}/${data.casesEvaluated} cases · ${data.failedCases} failed`} />
            <Kpi label="Cost per successful case" value={usd(data.costPerSuccessfulCase)} sub="eval spend ÷ passing cases" />
            <Kpi label="Latency p50 / p95" value={`${ms(data.latencyP50)} / ${ms(data.latencyP95)}`} sub={data.latencyNote} />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="Active prompt versions" value={`${data.activePromptVersions}`} />
            <Kpi label="Production agent runs" value={`${data.production.agentRuns}`} sub={`${data.production.runsWithRecordedPromptVersion} with a recorded prompt version`} />
            <Kpi label="Cost per completed run" value={usd(data.production.costPerCompletedRun)} sub={`${data.production.completed} completed`} />
            <Kpi label="Handoff rework" value={data.collaboration.reworkPerHandoff == null ? "—" : data.collaboration.reworkPerHandoff.toFixed(2)} sub={`${data.collaboration.bugReports} bug reports / ${data.collaboration.handoffs} handoffs`} />
          </div>
        </>
      )}
      {evals && evals.length > 0 && (
        <Card className="p-0 overflow-x-auto">
          <table className="table">
            <thead className="bg-bg-raised">
              <tr>
                {["When", "Agent", "Prompt", "Dataset", "Mode", "Label", "Result", "Cost", "Status"].map((h) => <th key={h}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {evals.slice(0, 25).map((e) => (
                <tr key={e.id} >
                  <td className="px-3 py-2 text-text-muted">{timeAgo(e.startedAt)}</td>
                  <td className="px-3 py-2">{e.agentKey}</td>
                  <td className="px-3 py-2 mono text-xs">v{e.promptVersion}</td>
                  <td className="px-3 py-2 mono text-xs">{e.datasetId}@{e.datasetVersion}</td>
                  <td className="px-3 py-2"><Badge tone={e.mode === "live" ? "brand" : "neutral"}>{e.mode === "live" ? "live" : "fixture"}</Badge></td>
                  <td className="px-3 py-2 text-text-muted">{e.label}</td>
                  <td className="px-3 py-2 mono">{e.passed}/{e.total}{e.skipped ? <span className="text-text-faint"> (+{e.skipped} skipped)</span> : null}</td>
                  <td className="px-3 py-2 mono">{usd(e.cost)}</td>
                  <td className="px-3 py-2"><Badge tone={e.status === "COMPLETED" ? "success" : e.status === "RUNNING" ? "info" : "warning"}>{e.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function RunEvaluationForm({ base, onDone }: { base: string; onDone: () => void }) {
  const { data: datasets } = useQuery<{ id: string; version: string; agentKey: string; caseCount: number; difficultCount: number }[]>(`${base}/datasets`);
  const [datasetId, setDatasetId] = useState("");
  const { mutate, loading, error } = useMutation<{ agentKey: string; datasetId: string }, { run: { passed: number; total: number; skipped: number } }>("POST");
  const toast = useApp((s) => s.toast);
  const ds = datasets?.find((d) => d.id === datasetId);
  return (
    <Card className="flex flex-wrap items-end gap-3">
      <div>
        <label className="label">Dataset (agent)</label>
        <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} className="input w-auto min-w-[300px]">
          <option value="">Select…</option>
          {datasets?.map((d) => (
            <option key={d.id} value={d.id}>{d.id}@{d.version} — {d.caseCount} cases ({d.difficultCount} difficult)</option>
          ))}
        </select>
      </div>
      <button
        disabled={!ds || loading}
        onClick={async () => {
          if (!ds) return;
          try {
            const r = await mutate(`${base}/evaluations`, { agentKey: ds.agentKey, datasetId: ds.id });
            toast({ title: "Evaluation complete", description: `${r.run.passed}/${r.run.total} passed${r.run.skipped ? `, ${r.run.skipped} skipped` : ""}`, level: "success" });
            onDone();
          } catch (e) {
            toast({ title: "Evaluation failed", description: (e as Error).message, level: "danger" });
          }
        }}
        className="btn-primary"
      >
        {loading ? "Running…" : "Run evaluation (active prompt)"}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
      <span className="text-2xs text-text-faint basis-full">
        Without ANTHROPIC_API_KEY, evaluations run against the deterministic simulator and are labelled “fixture”. Sandbox cases are skipped (not passed) without Docker.
      </span>
    </Card>
  );
}

// ---------------------------------------------------------------------------
interface ScorecardData {
  agentKey: string; name: string; role: string; sampleSize: number; evalsRun: number;
  confidence: { level: string; note: string };
  quality: Record<string, Metric>; reliability: Record<string, Metric>; efficiency: Record<string, Metric>;
  security: Record<string, Metric>; collaboration: Record<string, Metric>;
  topFailures: { category: string; count: number }[];
}

function ScorecardsTab({ base }: { base: string }) {
  const { data, loading } = useQuery<ScorecardData[]>(`${base}/scorecards`, 15000);
  const [open, setOpen] = useState<string | null>(null);
  if (loading && !data) return <Skeleton className="h-64" />;
  if (!data?.some((s) => s.sampleSize > 0))
    return <Card><EmptyState icon={ShieldCheck} title="No scorecard data" description="Scorecards populate from evaluation results. Run an evaluation from the Overview tab." /></Card>;
  const confTone = (l: string) => (l === "high" ? "success" : l === "moderate" ? "info" : l === "none" ? "neutral" : "warning");
  return (
    <Card className="p-0 overflow-x-auto">
      <table className="table">
        <thead className="bg-bg-raised">
          <tr>
            {["Agent", "Sample", "Acceptance", "Completion", "Tool failure", "Injection resist.", "Escalation", "Cost / success", "Top failure"].map((h) => <th key={h}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((s) => (
            <Fragment key={s.agentKey}>
              <tr className="border-b border-border/50 cursor-pointer hover:bg-bg-hover" onClick={() => setOpen(open === s.agentKey ? null : s.agentKey)}>
                <td className="px-3 py-2"><div>{s.name}</div><div className="text-2xs text-text-faint">{s.agentKey}</div></td>
                <td className="px-3 py-2"><Badge tone={confTone(s.confidence.level)}>{s.sampleSize} · {s.confidence.level}</Badge></td>
                <td className="px-3 py-2"><MetricCell m={s.quality.acceptanceSatisfied} /></td>
                <td className="px-3 py-2"><MetricCell m={s.reliability.completionRate} /></td>
                <td className="px-3 py-2"><MetricCell m={s.reliability.toolFailureRate} /></td>
                <td className="px-3 py-2"><MetricCell m={s.security.injectionResistanceRate} /></td>
                <td className="px-3 py-2"><MetricCell m={s.security.correctEscalationRate} /></td>
                <td className="px-3 py-2"><MetricCell m={s.efficiency.costPerSuccess} fmt={usd} /></td>
                <td className="px-3 py-2 text-xs mono">{s.topFailures[0] ? `${s.topFailures[0].category} ×${s.topFailures[0].count}` : "—"}</td>
              </tr>
              {open === s.agentKey && (
                <tr key={`${s.agentKey}-d`} className="border-b border-border/50 bg-bg-elevated/40">
                  <td colSpan={9} className="px-3 py-3">
                    <p className="text-xs text-text-muted mb-2">{s.confidence.note} Hover a value for its formula and counts.</p>
                    <div className="grid md:grid-cols-5 gap-3 text-xs">
                      {(["quality", "reliability", "efficiency", "security", "collaboration"] as const).map((dim) => (
                        <div key={dim}>
                          <div className="font-medium capitalize mb-1">{dim}</div>
                          {Object.entries(s[dim]).map(([k, m]) => (
                            <div key={k} className="flex justify-between gap-2">
                              <span className="text-text-muted">{k}</span>
                              <MetricCell m={m} fmt={m.unit === "USD" ? usd : m.unit === "ms" ? ms : m.unit ? (v) => (v == null ? "—" : v.toFixed(2)) : pct} />
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
interface Version { id: string; version: number; status: string; author: string; changelog: string; content: string; createdAt: string; activatedAt: string | null; datasetId: string | null }
interface Template { id: string; key: string; agentKey: string | null; purpose: string; versions: Version[] }
interface Experiment { id: string; templateId: string; baselineVersionId: string; candidateVersionId: string; datasetId: string; datasetVersion: string; status: string; recommendation: string | null; summary: string; comparison: string; createdAt: string; repetitions: number }

function PromptsTab({ base }: { base: string }) {
  const { data, refetch } = useQuery<{ templates: Template[]; promotions: { id: string; action: string; toVersionId: string; reason: string; createdAt: string; templateId: string }[] }>(`${base}/prompts`, 15000);
  const { data: experiments, refetch: refetchExp } = useQuery<Experiment[]>(`${base}/experiments`, 15000);
  const [sel, setSel] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [changelog, setChangelog] = useState("");
  const create = useMutation("POST");
  const exp = useMutation("POST");
  const promote = useMutation<unknown, { promoted: boolean; blockedReasons: string[] }>("POST");
  const rollback = useMutation("POST");
  const toast = useApp((s) => s.toast);

  const t = data?.templates.find((x) => x.key === sel) ?? data?.templates[0];
  if (!data) return <Skeleton className="h-64" />;
  if (!t) return <Card><EmptyState icon={GitCompare} title="No prompts registered" description="Built-in agent prompts are imported on first access." /></Card>;
  const active = t.versions.find((v) => v.status === "ACTIVE");
  const fail = (title: string) => (e: unknown) => toast({ title, description: (e as Error).message, level: "danger" });
  const tExps = experiments?.filter((e) => e.templateId === t.id) ?? [];

  return (
    <div className="grid lg:grid-cols-[260px_1fr] gap-4">
      <Card className="p-2 max-h-[70vh] overflow-y-auto">
        {data.templates.map((x) => (
          <button key={x.key} onClick={() => setSel(x.key)} className={cn("w-full text-left px-2 py-1.5 rounded text-sm", x.key === t.key ? "bg-brand/15 text-text" : "text-text-muted hover:text-text")}>
            <div className="mono text-xs">{x.key}</div>
            <div className="text-2xs text-text-faint">v{x.versions.find((v) => v.status === "ACTIVE")?.version ?? "—"} active · {x.versions.length} versions</div>
          </button>
        ))}
      </Card>
      <div className="space-y-4">
        <Card>
          <div className="section-title mb-2">Version history — {t.key}</div>
          <table className="table">
            <thead className="bg-bg-raised"><tr>{["Ver", "Status", "Author", "Changelog", "Created", ""].map((h) => <th key={h} className="py-1 pr-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {t.versions.map((v) => (
                <tr key={v.id} className="border-t border-border/50 align-top">
                  <td className="py-1.5 pr-2 mono">v{v.version}</td>
                  <td className="py-1.5 pr-2"><Badge tone={v.status === "ACTIVE" ? "success" : v.status === "APPROVED" ? "info" : v.status === "ROLLED_BACK" ? "warning" : "neutral"}>{v.status}</Badge></td>
                  <td className="py-1.5 pr-2 text-xs text-text-muted truncate max-w-[120px]">{v.author}</td>
                  <td className="py-1.5 pr-2 text-xs">{v.changelog}</td>
                  <td className="py-1.5 pr-2 text-xs text-text-muted">{timeAgo(v.createdAt)}</td>
                  <td className="py-1.5 text-right space-x-1 whitespace-nowrap">
                    {active && v.id !== active.id && ["DRAFT", "EVALUATING", "APPROVED"].includes(v.status) && (
                      <button className="btn-ghost btn-sm" disabled={exp.loading} onClick={() => exp.mutate(`${base}/experiments`, { templateKey: t.key, baselineVersionId: active.id, candidateVersionId: v.id }).then(() => { refetch(); refetchExp(); toast({ title: "Experiment complete", level: "success" }); }).catch(fail("Experiment failed"))}>
                        {exp.loading ? "running…" : "A/B vs active"}
                      </button>
                    )}
                    {v.status === "APPROVED" && v.id !== active?.id && !v.activatedAt && (
                      <button className="btn-secondary btn-sm" disabled={promote.loading} onClick={() => promote.mutate(`${base}/promote`, { candidateVersionId: v.id }).then((r) => { refetch(); toast({ title: r.promoted ? "Promoted" : "Promotion blocked", description: r.blockedReasons.join("; "), level: r.promoted ? "success" : "warning" }); }).catch(fail("Promotion failed"))}>
                        promote
                      </button>
                    )}
                    {v.activatedAt && v.status !== "ACTIVE" && ["APPROVED", "ROLLED_BACK"].includes(v.status) && (
                      <button className="btn-ghost btn-sm text-warning" disabled={rollback.loading} onClick={() => rollback.mutate(`${base}/rollback`, { templateKey: t.key, targetVersionId: v.id, reason: "manual rollback from prompt lab" }).then(() => { refetch(); toast({ title: `Rolled back to v${v.version}`, level: "warning" }); }).catch(fail("Rollback failed"))}>
                        roll back to
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-2xs text-text-faint mt-2">Versions are immutable (content-hashed). Promotion requires ADMIN, an APPROVED experiment result, and a fresh regression run passing all release gates.</p>
        </Card>

        <Card>
          <div className="section-title mb-2">Create candidate version</div>
          <textarea value={draft || active?.content || ""} onChange={(e) => setDraft(e.target.value)} rows={5} className="input mono text-xs" />
          <div className="flex gap-2 mt-2">
            <input value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="Changelog (what & why)" className="input flex-1" />
            <button
              disabled={create.loading || changelog.length < 3}
              className="btn-primary"
              onClick={() => create.mutate(`${base}/prompts`, { templateKey: t.key, content: draft || active?.content, changelog }).then(() => { setDraft(""); setChangelog(""); refetch(); }).catch(fail("Could not create version"))}
            >
              Save as DRAFT v{(t.versions[0]?.version ?? 0) + 1}
            </button>
          </div>
        </Card>

        <Card>
          <div className="section-title mb-2">Experiments</div>
          {tExps.length === 0 ? (
            <p className="text-sm text-text-muted">No experiments for this prompt yet.</p>
          ) : (
            tExps.map((e) => <ExperimentRow key={e.id} e={e} versions={t.versions} />)
          )}
        </Card>

        <Card>
          <div className="section-title mb-2">Promotion & rollback history</div>
          {data.promotions.filter((p) => p.templateId === t.id).length === 0 ? (
            <p className="text-sm text-text-muted">No promotions recorded.</p>
          ) : (
            data.promotions.filter((p) => p.templateId === t.id).map((p) => (
              <div key={p.id} className="text-xs border-t border-border/50 py-1.5 flex gap-2">
                <Badge tone={p.action === "PROMOTE" ? "success" : p.action === "ROLLBACK" ? "warning" : "danger"}>{p.action}</Badge>
                <span className="mono">→ v{t.versions.find((v) => v.id === p.toVersionId)?.version}</span>
                <span className="text-text-muted flex-1">{p.reason}</span>
                <span className="text-text-faint">{timeAgo(p.createdAt)}</span>
              </div>
            ))
          )}
        </Card>
      </div>
    </div>
  );
}

function ExperimentRow({ e, versions }: { e: Experiment; versions: Version[] }) {
  const c = JSON.parse(e.comparison || "{}") as {
    deltas?: { metric: string; baseline: number; candidate: number }[];
    gates?: { checks: { name: string; pass: boolean; detail: string; waivable: boolean }[] };
    variance?: { baseline: { n: number; passRateStdev: number | null }; candidate: { n: number; passRateStdev: number | null } };
    candidateFailures?: { caseId: string; failureCategory?: string; detail: string }[];
    mode?: string;
  };
  const v = (id: string) => versions.find((x) => x.id === id)?.version;
  return (
    <div className="border-t border-border/50 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="mono">v{v(e.baselineVersionId)} vs v{v(e.candidateVersionId)}</span>
        <span className="text-xs text-text-muted mono">{e.datasetId}@{e.datasetVersion} ×{e.repetitions}</span>
        <Badge tone={c.mode === "live" ? "brand" : "neutral"}>{c.mode === "live" ? "live" : "fixture"}</Badge>
        <Badge tone={e.recommendation === "promote" ? "success" : e.recommendation === "block" ? "danger" : "warning"}>{e.recommendation ?? e.status}</Badge>
        <span className="text-text-faint text-xs ml-auto">{timeAgo(e.createdAt)}</span>
      </div>
      <p className="text-xs text-text-muted mt-1">{e.summary}</p>
      {c.mode !== "live" && <p className="text-2xs text-warning mt-1">Fixture mode: the simulator does not read prompt wording, so this compares the harness, not prompt quality. Use a live key for real prompt comparisons.</p>}
      {c.deltas && (
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mt-2 text-xs">
          {c.deltas.map((d) => (
            <div key={d.metric} className="bg-bg-elevated rounded p-1.5">
              <div className="text-text-faint">{d.metric}</div>
              <div className="mono">{d.baseline.toFixed(4)} → {d.candidate.toFixed(4)}</div>
            </div>
          ))}
        </div>
      )}
      {c.gates && (
        <div className="flex flex-wrap gap-1 mt-2">
          {c.gates.checks.map((g) => (
            <span key={g.name} title={g.detail}>
              <Badge tone={g.pass ? "success" : g.waivable ? "warning" : "danger"}>{g.pass ? "✓" : "✗"} {g.name}</Badge>
            </span>
          ))}
        </div>
      )}
      {c.variance && c.variance.candidate.n > 1 && (
        <p className="text-2xs text-text-faint mt-1">Pass-rate σ: baseline {c.variance.baseline.passRateStdev?.toFixed(3)} · candidate {c.variance.candidate.passRateStdev?.toFixed(3)} over {c.variance.candidate.n} runs</p>
      )}
      {c.candidateFailures && c.candidateFailures.length > 0 && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-text-muted">{c.candidateFailures.length} failing candidate case(s)</summary>
          {c.candidateFailures.map((f) => <div key={f.caseId} className="mono text-2xs mt-0.5">{f.caseId} · {f.failureCategory} · {f.detail}</div>)}
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
interface ModelsData {
  mode: string;
  models: Record<string, string>;
  policy: Record<string, unknown>;
  performance: { model: string; taskCategory: string; evidenceMode?: string; sampleSize: number; correctness: number; securityScore: number; structuredValidity: number; avgCost: number; avgLatencyMs: number }[];
  decisions: { taskCategory: string; usedSafeDefault: boolean; reason: string; chosen: { model: string } | null; consideredCount: number; eligibleCount: number }[];
}

function ModelsTab({ base }: { base: string }) {
  const { data } = useQuery<ModelsData>(`${base}/models`, 20000);
  const { data: cost } = useQuery<{ recommendations: { id: string; title: string; evidence: string; sampleSize: number; expectedImpact: string; confidence: string; risks: string; verification: string }[]; note: string }>(`${base}/cost`, 20000);
  if (!data) return <Skeleton className="h-64" />;
  return (
    <div className="space-y-4">
      <Card>
        <div className="section-title mb-1">Tier → model (provider abstraction)</div>
        <div className="flex gap-2 flex-wrap text-xs">{Object.entries(data.models).map(([t, m]) => <Badge key={t}>{t}: {m}</Badge>)} <Badge tone={data.mode === "live" ? "brand" : "neutral"}>mode: {data.mode}</Badge></div>
      </Card>
      <Card className="p-0 overflow-x-auto">
        <div className="section-title px-3 pt-3">Measured model performance by task category</div>
        {data.performance.length === 0 ? (
          <p className="text-sm text-text-muted p-3">No evaluation data yet — routing uses the safe default for every category.</p>
        ) : (
          <table className="table mt-2">
            <thead className="bg-bg-raised"><tr>{["Model", "Category", "Evidence", "n", "Correctness", "Security", "Validity", "Avg cost", "Avg latency"].map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {data.performance.map((p) => (
                <tr key={p.model + p.taskCategory} >
                  <td className="px-3 py-2 mono text-xs">{p.model}</td><td className="px-3 py-2">{p.taskCategory}</td><td className="px-3 py-2"><Badge tone={p.evidenceMode === "live" ? "brand" : "neutral"}>{p.evidenceMode === "live" ? "live" : "fixture — not used for routing"}</Badge></td><td className="px-3 py-2 mono">{p.sampleSize}</td>
                  <td className="px-3 py-2 mono">{pct(p.correctness)}</td><td className="px-3 py-2 mono">{pct(p.securityScore)}</td><td className="px-3 py-2 mono">{pct(p.structuredValidity)}</td>
                  <td className="px-3 py-2 mono">{usd(p.avgCost)}</td><td className="px-3 py-2 mono">{ms(p.avgLatencyMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card>
        <div className="section-title mb-2">Routing decisions (policy: min correctness {String(data.policy.minCorrectness)}, min samples {String(data.policy.minSampleSize)}, security-sensitive floor {String(data.policy.securitySensitiveMinSecurity)})</div>
        {data.decisions.map((d) => (
          <div key={d.taskCategory} className="text-xs border-t border-border/50 py-1.5 flex gap-2 items-start">
            <span className="w-36 shrink-0">{d.taskCategory}</span>
            <Badge tone={d.usedSafeDefault ? "neutral" : "success"}>{d.chosen ? d.chosen.model : "safe default"}</Badge>
            <span className="text-text-muted">{d.reason}</span>
          </div>
        ))}
      </Card>
      <Card>
        <div className="section-title mb-1">Cost optimization proposals</div>
        <p className="text-2xs text-text-faint mb-2">{cost?.note}</p>
        {!cost?.recommendations.length ? <p className="text-sm text-text-muted">No evidence-backed recommendations yet.</p> : cost.recommendations.map((r) => (
          <div key={r.id} className="border-t border-border/50 py-2 text-xs">
            <div className="flex gap-2 items-center"><span className="font-medium text-sm">{r.title}</span><Badge tone={r.confidence === "high" ? "success" : r.confidence === "medium" ? "info" : "warning"}>{r.confidence} · n={r.sampleSize}</Badge></div>
            <div className="text-text-muted mt-1">Evidence: {r.evidence}</div>
            <div>Expected impact: {r.expectedImpact}</div>
            <div className="text-warning">Risks: {r.risks}</div>
            <div className="text-text-faint">Verify: {r.verification}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
interface FailureData {
  totalFailures: number;
  distribution: { category: string; label: string; count: number }[];
  productionDistribution: { category: string; label: string; count: number }[];
  hypotheses: { category: string; count: number; share: number; hypothesis: string; confidence: string; evidence: string }[];
  repeated: { key: string; count: number; category: string; lastDetail: string }[];
  promotionHistory: { id: string; action: string; reason: string; createdAt: string }[];
}

function FailuresTab({ base }: { base: string }) {
  const { data } = useQuery<FailureData>(`${base}/failures`, 15000);
  if (!data) return <Skeleton className="h-64" />;
  const max = Math.max(1, ...data.distribution.map((d) => d.count));
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <Card>
        <div className="section-title mb-2">Evaluation failure distribution ({data.totalFailures})</div>
        {data.distribution.length === 0 ? <p className="text-sm text-text-muted">No failed evaluation cases recorded.</p> : data.distribution.map((d) => (
          <div key={d.category} className="flex items-center gap-2 text-xs py-0.5">
            <span className="w-48 shrink-0">{d.label}</span>
            <div className="flex-1 bg-bg-elevated rounded h-3"><div className="h-3 rounded bg-danger/60" style={{ width: `${(d.count / max) * 100}%` }} /></div>
            <span className="mono w-8 text-right">{d.count}</span>
          </div>
        ))}
        {data.productionDistribution.length > 0 && (
          <>
            <div className="text-xs font-medium mt-3 mb-1">Production agent-run failures</div>
            {data.productionDistribution.map((d) => <div key={d.category} className="text-xs flex justify-between"><span>{d.label}</span><span className="mono">{d.count}</span></div>)}
          </>
        )}
      </Card>
      <Card>
        <div className="section-title mb-2">Root-cause hypotheses</div>
        <p className="text-2xs text-text-faint mb-2">Hypotheses, not proven causes. Confidence reflects sample size and share.</p>
        {data.hypotheses.length === 0 ? <p className="text-sm text-text-muted">Nothing to analyse yet.</p> : data.hypotheses.map((h) => (
          <div key={h.category} className="border-t border-border/50 py-1.5 text-xs">
            <div className="flex gap-2"><span className="font-medium">{h.category}</span><Badge tone={h.confidence === "high" ? "danger" : h.confidence === "medium" ? "warning" : "neutral"}>{h.confidence}</Badge></div>
            <div className="text-text-muted">{h.hypothesis}</div>
            <div className="text-text-faint">{h.evidence}</div>
          </div>
        ))}
      </Card>
      <Card>
        <div className="section-title mb-2">Repeated failures (same case ≥2 evaluations)</div>
        {data.repeated.length === 0 ? <p className="text-sm text-text-muted">None.</p> : data.repeated.map((r) => (
          <div key={r.key} className="text-xs border-t border-border/50 py-1"><span className="mono">{r.key}</span> ×{r.count} · {r.category}<div className="text-text-faint">{r.lastDetail}</div></div>
        ))}
      </Card>
      <Card>
        <div className="section-title mb-2">Promotion / regression history</div>
        {data.promotionHistory.length === 0 ? <p className="text-sm text-text-muted">No promotions or blocked promotions yet.</p> : data.promotionHistory.map((p) => (
          <div key={p.id} className="text-xs border-t border-border/50 py-1 flex gap-2"><Badge tone={p.action === "PROMOTE" ? "success" : p.action === "BLOCKED" ? "danger" : "warning"}>{p.action}</Badge><span className="flex-1 text-text-muted">{p.reason}</span><span className="text-text-faint">{timeAgo(p.createdAt)}</span></div>
        ))}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
interface Entry { id: string; title: string; lesson: string; evidence: string; confidence: string; status: string; sourceType: string; sourceId: string | null; agentKey: string | null; createdAt: string; lastVerifiedAt: string | null; reviewNote: string }

function KnowledgeTab({ base }: { base: string }) {
  const { data, refetch } = useQuery<Entry[]>(`${base}/knowledge`, 15000);
  const { data: evals } = useQuery<{ id: string; agentKey: string; failed: number; datasetId: string; startedAt: string }[]>(`${base}/evaluations`);
  const propose = useMutation("POST");
  const toast = useApp((s) => s.toast);
  const act = (id: string, action: string, extra?: object) =>
    fetch(`${base}/knowledge/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) })
      .then(async (r) => { const j = await r.json(); if (!j.ok) throw new Error(j.error); refetch(); })
      .catch((e) => toast({ title: "Review failed", description: (e as Error).message, level: "danger" }));
  const failing = evals?.filter((e) => e.failed > 0).slice(0, 5) ?? [];
  return (
    <div className="space-y-4">
      {failing.length > 0 && (
        <Card className="text-xs">
          <div className="section-title mb-1">Propose lessons from failing evaluations</div>
          {failing.map((e) => (
            <button key={e.id} className="btn-secondary btn-sm mr-2" disabled={propose.loading} onClick={() => propose.mutate(`${base}/knowledge`, { source: "evaluation", sourceId: e.id }).then(() => refetch())}>
              {e.agentKey}/{e.datasetId} ({e.failed} failed)
            </button>
          ))}
        </Card>
      )}
      {!data?.length ? (
        <Card><EmptyState icon={BookOpen} title="No proposed knowledge" description="Lessons are proposed from completed tasks and evaluations, and must be approved before they become shared knowledge." /></Card>
      ) : (
        data.map((k) => (
          <Card key={k.id}>
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{k.title}</span>
              <Badge tone={k.status === "APPROVED" ? "success" : k.status === "PROPOSED" ? "info" : "neutral"}>{k.status}</Badge>
              <Badge tone={k.confidence === "high" ? "success" : k.confidence === "medium" ? "info" : "warning"}>{k.confidence} confidence</Badge>
              <span className="text-2xs text-text-faint ml-auto">{k.sourceType} · {timeAgo(k.createdAt)}{k.lastVerifiedAt ? ` · verified ${timeAgo(k.lastVerifiedAt)}` : ""}</span>
            </div>
            <p className="text-sm mt-1">{k.lesson}</p>
            <details className="text-xs mt-1"><summary className="cursor-pointer text-text-muted">Evidence</summary>
              {JSON.parse(k.evidence || "[]").map((ev: { type: string; ref: string; detail: string }, i: number) => <div key={i} className="mono text-2xs">{ev.type} · {ev.ref} · {ev.detail}</div>)}
            </details>
            <div className="flex gap-3 mt-2 text-xs">
              {k.status === "PROPOSED" && <button className="text-success" onClick={() => act(k.id, "approve", { note: "approved in review" })}>Approve</button>}
              {k.status === "PROPOSED" && <button className="text-danger" onClick={() => act(k.id, "reject")}>Reject</button>}
              {["PROPOSED", "APPROVED"].includes(k.status) && <button className="text-text-muted" onClick={() => { const lesson = prompt("Edit lesson", k.lesson); if (lesson) act(k.id, "edit", { edit: { lesson } }); }}>Edit</button>}
              {["PROPOSED", "APPROVED"].includes(k.status) && <button className="text-warning" onClick={() => act(k.id, "deprecate")}>Deprecate</button>}
              <button className="text-text-faint" onClick={() => fetch(`${base}/knowledge/${k.id}`, { method: "DELETE" }).then(() => refetch())}>Delete</button>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

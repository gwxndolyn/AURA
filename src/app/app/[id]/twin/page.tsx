"use client";

import Link from "next/link";
import { Suspense, use, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Circle, FlaskConical, GitCompare, Loader2, Play, Save, Sparkles, XCircle } from "lucide-react";
import { useQuery, fetchJSON } from "@/hooks/useApi";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { PageHeader, ErrorState, Skeleton, Badge, Section } from "@/components/ui/primitives";
import { OpsMap, type DeptSummary } from "@/components/twin/ops-map";
import { useApp } from "@/lib/store";
import { cn, timeAgo } from "@/lib/utils";

type Alloc = { feature: number; quality: number; reliability: number; security: number };
type Priority = "ship_feature" | "fix_reliability" | "resolve_security" | "reduce_cost";
interface Decisions {
  allocation: Alloc;
  priorities: Priority[];
  capacity?: Partial<Record<"engineering" | "qa" | "infra" | "security", number>>;
  verificationGate: boolean;
  riskPolicy: "cautious" | "balanced" | "aggressive";
  useRollback?: boolean;
}
interface Metric { key: string; label: string; kind: string; value: number | null; unit: string; definition: string; source: string; window: string; sample: number; note?: string }
interface Overview {
  company: { name: string; mission: string; isDemo: boolean } | null;
  live: {
    departments: (DeptSummary & { activeTasks: { id: string; key: string; title: string; agentKey: string; status: string; missionId: string; missionTitle: string }[]; recentRuns: { id: string; missionId: string; taskKey: string; agentKey: string; status: string; outcome: string; errorCategory: string | null; startedAt: string }[] })[];
    qa: { verificationRuns: number; passed: number; failed: number; checks: { id: string; check: string; status: string; passed: number | null; total: number | null; createdAt: string }[] };
    security: { missionFindings: { id: string; code: string; title: string; severity: string; missionId: string }[]; cyberRangeIncidents: { id: string; number: number; title: string; severity: string; status: string }[]; cyberRangeFindings: { id: string; code: string; title: string; severity: string; status: string }[]; opsFindings: { id: string; title: string; severity: string }[] };
    infra: { deployments: { id: string; env: string; version: string; status: string; createdAt: string }[]; simulatedPipeline: boolean };
    pendingApprovals: number;
    openOpsFindings: number;
  };
  metrics: Metric[];
  config: { version: number; allocation: Alloc; priorities: Priority[]; capacity: Decisions["capacity"]; riskPolicy: Decisions["riskPolicy"]; budgetUsd: number; objectives: string[]; history: { version: number; at: string; by: string; change: string }[] };
  canDecide: boolean;
  canRun: boolean;
}
interface ScenarioDef { id: string; title: string; situation: string[]; objectives: string[]; actions: string[]; constraints: string[]; successCriteria: { id: string; text: string }[]; seed: number; initial: { horizon: number; budgetUsd: number; costPerSlotTick: number; capacity: Record<string, number>; items: { id: string; title: string; kind: string; effort: number; value: number; deadline?: number; dependsOn?: string[]; blockedUntil?: number; needsService?: string }[]; incidents: { id: string; service: string; startsAt: number; mitigationEffort: number }[] }; defaults: Decisions }
interface RunRow { id: string; scenario: string; kind: string; baselineId: string | null; label: string; rulesVersion: string; seed: number; inputHash: string; resultHash: string; saved: boolean; createdBy: string; createdAt: string; metrics?: Record<string, number | null>; criteria?: { id: string; met: boolean }[]; composite?: number; inputs: Decisions }
interface Compare {
  runs: { id: string; label: string; kind: string; seed: number; criteria: { id: string; text: string; met: boolean }[]; composite: { score: number; components: Record<string, { value: number; weight: number; contribution: number }>; formula: string } }[];
  decisionDiffs: { runId: string; diffs: string[] }[];
  metrics: { key: string; label: string; values: (number | null)[] }[];
  explanations: { runId: string; notes: string[] }[];
  caveat: string;
}
interface TimelineItem { id: string; at: string; simDay?: number; provenance: "operational" | "simulation"; dept: string | null; type: string; text: string; ref?: { kind: string; id: string }; runId?: string }

const PRIORITY_LABEL: Record<Priority, string> = { ship_feature: "Ship features", fix_reliability: "Fix reliability", resolve_security: "Resolve security", reduce_cost: "Reduce cost" };
const fmt = (m: Metric) => (m.value === null ? "insufficient data" : m.unit === "ratio" ? `${Math.round(m.value * 100)}%` : m.unit === "usd" ? `$${m.value.toFixed(4)}` : m.unit === "hours" ? `${m.value.toFixed(2)} h` : String(m.value));

export default function TwinPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="page"><Skeleton className="h-80" /></div>}>
      <Twin params={params} />
    </Suspense>
  );
}

function Twin({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const search = useSearchParams();
  const { toast } = useApp();
  const base = `/api/companies/${id}/twin`;
  const { data: o, error, refetch } = useQuery<Overview>(base, 10000);
  const { data: lib } = useQuery<{ rulesVersion: string; capacityLimits: Record<string, [number, number]>; scenarios: ScenarioDef[] }>(`${base}/scenarios`);
  const [scenarioId, setScenarioId] = useState(search.get("scenario") ?? "delivery_crunch");
  const { data: runs, refetch: refetchRuns } = useQuery<RunRow[]>(`${base}/runs?scenario=${scenarioId}`);
  const [dept, setDept] = useState<DeptSummary["key"] | null>(null);
  const [tab, setTab] = useState<"scenario" | "compare" | "timeline" | "metrics" | "decisions">((search.get("tab") as never) ?? "scenario");
  const [draft, setDraft] = useState<Decisions | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cmp, setCmp] = useState<string[]>([]);
  const { version } = useLiveEvents(id);
  useEffect(() => {
    if (version > 0) refetch();
  }, [version, refetch]);

  const sc = lib?.scenarios.find((s) => s.id === scenarioId);
  useEffect(() => {
    if (sc) setDraft(structuredClone(sc.defaults));
  }, [sc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const baselineRun = runs?.find((r) => r.kind === "baseline");
  const allocSum = draft ? Math.round((draft.allocation.feature + draft.allocation.quality + draft.allocation.reliability + draft.allocation.security) * 100) : 0;

  async function run(kind: "baseline" | "what_if") {
    if (!draft || !sc) return;
    setBusy(kind);
    try {
      const r = await fetchJSON<{ id: string }>(`${base}/runs`, { method: "POST", body: JSON.stringify({ scenario: sc.id, kind, baselineId: kind === "what_if" ? baselineRun?.id : undefined, label: kind === "baseline" ? "Baseline" : undefined, decisions: draft }) });
      toast({ title: kind === "baseline" ? "Baseline simulated" : "What-if simulated", description: "Simulated result — no real mission, deployment or service was touched.", level: "success" });
      await refetchRuns();
      if (kind === "what_if" && baselineRun) {
        setCmp([baselineRun.id, r.id]);
        setTab("compare");
      }
    } catch (e) {
      toast({ title: "Simulation not run", description: (e as Error).message, level: "danger" });
    } finally {
      setBusy(null);
    }
  }

  async function saveRun(runId: string) {
    const label = window.prompt("Name this scenario", "Preferred plan") ?? undefined;
    try {
      await fetchJSON(`${base}/runs/${runId}`, { method: "POST", body: JSON.stringify({ action: "save", label }) });
      refetchRuns();
      toast({ title: "Scenario saved", level: "success" });
    } catch (e) {
      toast({ title: "Not saved", description: (e as Error).message, level: "danger" });
    }
  }

  if (error && !o) return <div className="page"><ErrorState message={error} onRetry={refetch} /></div>;
  if (!o) return <div className="page space-y-3"><Skeleton className="h-10 w-1/3" /><Skeleton className="h-72" /></div>;
  const selected = dept ? o.live.departments.find((d) => d.key === dept) : null;

  return (
    <div className="page" data-testid="twin">
      <PageHeader
        title="Company twin"
        description={<>Operational areas show <strong className="font-medium text-text">real</strong> workspace activity. Scenarios, CEO decisions and what-ifs are <strong className="font-medium text-text">simulated</strong> by a deterministic engine ({lib?.rulesVersion ?? "…"}) over synthetic work — they never touch real missions, deployments or services.</>}
        meta={<><Badge>operational + simulation</Badge>{o.company?.isDemo && <Badge>demo workspace</Badge>}</>}
      />

      {/* Operations map — real data */}
      <section className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="rounded-lg border border-border bg-bg-inset p-3">
          <div className="mb-2 flex items-center gap-2"><h2 className="section-title">Operations map</h2><Badge tone="success">operational</Badge><span className="ml-auto text-2xs text-text-faint">{o.live.pendingApprovals} approval(s) pending · {o.live.openOpsFindings} open ops finding(s)</span></div>
          <OpsMap departments={o.live.departments} selected={dept} onSelect={(k) => setDept(dept === k ? null : k)} />
        </div>
        <aside className="rounded-lg border border-border p-3 text-sm" aria-label="Area details" data-testid="dept-panel">
          {!selected ? (
            <p className="text-text-muted">Select an area on the map (or Tab + Enter) to see its real agents, tasks and recent executions.</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2"><h3 className="font-medium">{selected.label}</h3><Badge tone="success">operational</Badge></div>
              <div>
                <div className="metric-label mb-1">Agents</div>
                <ul className="space-y-0.5 text-xs">{selected.agents.map((a) => <li key={a.key} className="flex gap-2"><span className={cn("dot mt-1.5", ["THINKING", "WORKING"].includes(a.status) ? "bg-brand" : "bg-text-faint")} /><span className="mono">{a.key}</span><span className="text-text-faint">{a.status.toLowerCase()}{a.available ? "" : " · unavailable"}</span></li>)}</ul>
              </div>
              <div>
                <div className="metric-label mb-1">Active mission tasks ({selected.activeTasks.length})</div>
                {selected.activeTasks.length === 0 ? <p className="text-xs text-text-muted">None. Missions you start appear here.</p> : (
                  <ul className="space-y-0.5 text-xs">{selected.activeTasks.slice(0, 8).map((t) => <li key={t.id}><Link className="hover:underline" href={`/app/${id}/missions/${t.missionId}`}>{t.title}</Link> <span className="mono text-text-faint">{t.status.toLowerCase()} · {t.agentKey}</span></li>)}</ul>
                )}
              </div>
              <div>
                <div className="metric-label mb-1">Recent executions (7 days)</div>
                {selected.recentRuns.length === 0 ? <p className="text-xs text-text-muted">No recorded task runs.</p> : (
                  <ul className="space-y-0.5 text-xs">{selected.recentRuns.slice(0, 6).map((r) => <li key={r.id} className="flex gap-2"><span className={r.status === "FAILED" ? "text-danger" : "text-success"}>{r.status === "FAILED" ? "✕" : "✓"}</span><Link className="truncate hover:underline" href={`/app/${id}/missions/${r.missionId}`}>{r.taskKey}</Link><span className="mono text-text-faint">{r.outcome || r.errorCategory}</span><span className="ml-auto text-text-faint">{timeAgo(r.startedAt)}</span></li>)}</ul>
                )}
              </div>
              {selected.key === "qa" && <p className="text-xs text-text-muted">Verification verdicts: {o.live.qa.passed} passed, {o.live.qa.failed} failed of {o.live.qa.verificationRuns} (7 days). Workspace checks: {o.live.qa.checks.length}. <Link className="underline" href={`/app/${id}/code`}>Open code workspace</Link></p>}
              {selected.key === "security" && (
                <div className="text-xs">
                  <p className="text-text-muted">Open mission findings: {o.live.security.missionFindings.length} · cyber-range incidents: {o.live.security.cyberRangeIncidents.length} · cyber-range findings: {o.live.security.cyberRangeFindings.length} <span className="text-text-faint">(cyber range is a simulated environment)</span></p>
                  <ul className="mt-1 space-y-0.5">{[...o.live.security.missionFindings.map((f) => `${f.code} ${f.title}`), ...o.live.security.cyberRangeIncidents.map((i) => `#${i.number} ${i.title} (${i.status.toLowerCase()})`)].slice(0, 6).map((x) => <li key={x}>{x}</li>)}</ul>
                </div>
              )}
              {selected.key === "infra" && <p className="text-xs text-text-muted">Deployments (7 days): {o.live.infra.deployments.length} — {o.live.infra.deployments.filter((d) => d.status === "FAILED").length} failed. The deployment pipeline is simulated. <Link className="underline" href={`/app/${id}/deployments`}>Open deployments</Link></p>}
            </div>
          )}
        </aside>
      </section>

      <div className="tabs mb-4" role="tablist">
        {(["scenario", "compare", "timeline", "metrics", "decisions"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} data-active={tab === t} onClick={() => setTab(t)} className="tab">{t === "scenario" ? "Scenarios" : t === "compare" ? "Compare" : t === "timeline" ? "Timeline" : t === "metrics" ? "Performance" : "CEO decisions"}</button>
        ))}
      </div>

      {tab === "scenario" && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-4">
            <div className="segmented" role="group" aria-label="Scenario">
              {lib?.scenarios.map((s) => <button key={s.id} data-active={scenarioId === s.id} onClick={() => { setScenarioId(s.id); router.replace(`/app/${id}/twin?scenario=${s.id}`, { scroll: false }); }}>{s.title}</button>)}
            </div>
            {sc && (
              <div className="rounded-lg border border-border p-4 text-sm" data-testid="scenario-def">
                <div className="flex items-center gap-2"><h2 className="font-medium">{sc.title}</h2><Badge tone="warning">simulation</Badge><span className="mono text-2xs text-text-faint">seed {sc.seed} · {lib?.rulesVersion}</span></div>
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-text-muted">{sc.situation.map((x) => <li key={x}>{x}</li>)}</ul>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div><div className="metric-label mb-1">Success criteria</div><ul className="space-y-0.5 text-xs">{sc.successCriteria.map((c) => <li key={c.id}>· {c.text}</li>)}</ul></div>
                  <div><div className="metric-label mb-1">Constraints</div><ul className="space-y-0.5 text-xs text-text-muted">{sc.constraints.map((c) => <li key={c}>· {c}</li>)}</ul></div>
                </div>
                <div className="metric-label mb-1 mt-3">Synthetic work items</div>
                <div className="overflow-x-auto">
                  <table className="table text-xs" data-testid="scenario-items">
                    <thead><tr><th>Item</th><th>Kind</th><th>Effort</th><th>Value</th><th>Deadline</th><th>Depends on / blocker</th></tr></thead>
                    <tbody>{sc.initial.items.map((i) => <tr key={i.id}><td><span className="mono">{i.id}</span> <span className="text-text-muted">{i.title}</span></td><td>{i.kind}</td><td className="mono">{i.effort}d</td><td className="mono">{i.value}</td><td className="mono">{i.deadline ? `day ${i.deadline}` : "—"}</td><td className="text-text-muted">{[...(i.dependsOn ?? []), i.blockedUntil ? `external until day ${i.blockedUntil}` : "", i.needsService ? `needs ${i.needsService}` : ""].filter(Boolean).join(", ") || "—"}</td></tr>)}</tbody>
                  </table>
                </div>
                <p className="mono mt-2 text-2xs text-text-faint">capacity {Object.entries(sc.initial.capacity).map(([k, v]) => `${k} ${v}`).join(" · ")} · budget ${sc.initial.budgetUsd.toLocaleString()} at ${sc.initial.costPerSlotTick.toLocaleString()}/slot-day · horizon {sc.initial.horizon} days{sc.initial.incidents.length ? ` · incident on ${sc.initial.incidents[0].service} day ${sc.initial.incidents[0].startsAt}` : ""}</p>
              </div>
            )}
            <Section title="Runs">
              {!runs ? <Skeleton className="h-24" /> : runs.length === 0 ? <p className="text-sm text-text-muted">No runs yet. Run the baseline with the documented defaults first.</p> : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="table text-xs" data-testid="runs">
                    <thead className="bg-bg-raised"><tr><th /><th>Run</th><th>Criteria</th><th>Delivered</th><th>On time</th><th>Wait</th><th>Budget used</th><th>Seed</th><th>Result hash</th><th /></tr></thead>
                    <tbody>{runs.map((r) => (
                      <tr key={r.id} data-run={r.kind} data-saved={r.saved}>
                        <td><input type="checkbox" aria-label={`Compare ${r.label}`} checked={cmp.includes(r.id)} onChange={(e) => setCmp((c) => (e.target.checked ? [...c, r.id].slice(-4) : c.filter((x) => x !== r.id)))} /></td>
                        <td><span className="font-medium">{r.label}</span> <span className="text-text-faint">{r.kind}{r.saved ? " · saved" : ""} · {timeAgo(r.createdAt)}</span></td>
                        <td className="mono">{r.criteria ? `${r.criteria.filter((c) => c.met).length}/${r.criteria.length}` : "—"}</td>
                        <td className="mono">{r.metrics?.delivered ?? "—"}</td>
                        <td className="mono">{r.metrics ? `${r.metrics.onTime}/${r.metrics.deadlineItems}` : "—"}</td>
                        <td className="mono">{r.metrics?.avgWaitTicks ?? "—"}</td>
                        <td className="mono">${(r.metrics?.budgetUsed ?? 0).toLocaleString()}</td>
                        <td className="mono">{r.seed}</td>
                        <td className="mono text-text-faint" title={r.resultHash}>{r.resultHash.slice(0, 10)}</td>
                        <td>{!r.saved && o.canRun && <button onClick={() => saveRun(r.id)} className="btn-ghost btn-sm" aria-label={`Save ${r.label}`}><Save className="h-3 w-3" /></button>}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              <div className="mt-2 flex gap-2">
                <button onClick={() => { setTab("compare"); }} disabled={cmp.length < 2} className="btn-secondary btn-sm"><GitCompare className="h-3 w-3" /> Compare selected ({cmp.length})</button>
              </div>
            </Section>
          </div>

          {/* Decisions for this run */}
          <aside className="rounded-lg border border-border p-4 text-sm" aria-label="Simulation decisions" data-testid="decisions">
            <div className="mb-2 flex items-center gap-2"><h3 className="font-medium">Decisions for the next run</h3><Badge tone="warning">simulation</Badge></div>
            {!draft ? <Skeleton className="h-40" /> : (
              <div className="space-y-3">
                <div>
                  <div className="metric-label mb-1">Budget allocation <span className={cn("normal-case tracking-normal", allocSum === 100 ? "text-text-faint" : "text-danger")}>· {allocSum}% (must be 100%)</span></div>
                  {(["feature", "quality", "reliability", "security"] as const).map((k) => (
                    <label key={k} className="flex items-center gap-2 text-xs">
                      <span className="w-20">{k}</span>
                      <input type="range" min={0} max={100} step={5} value={Math.round(draft.allocation[k] * 100)} onChange={(e) => setDraft({ ...draft, allocation: { ...draft.allocation, [k]: Number(e.target.value) / 100 } })} className="flex-1" aria-label={`${k} allocation`} />
                      <span className="mono w-10 text-right">{Math.round(draft.allocation[k] * 100)}%</span>
                    </label>
                  ))}
                </div>
                <div>
                  <div className="metric-label mb-1">Priority order (top = most important)</div>
                  <ol className="space-y-1 text-xs">
                    {draft.priorities.map((p, i) => (
                      <li key={p} className="flex items-center gap-2">
                        <span className="mono w-4 text-text-faint">{i + 1}</span><span className="flex-1">{PRIORITY_LABEL[p]}</span>
                        <button className="icon-btn h-5 w-5" aria-label={`Move ${PRIORITY_LABEL[p]} up`} disabled={i === 0} onClick={() => { const n = [...draft.priorities]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setDraft({ ...draft, priorities: n }); }}>↑</button>
                        <button className="icon-btn h-5 w-5" aria-label={`Move ${PRIORITY_LABEL[p]} down`} disabled={i === 3} onClick={() => { const n = [...draft.priorities]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setDraft({ ...draft, priorities: n }); }}>↓</button>
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <div className="metric-label mb-1">Simulated capacity (agent-slots)</div>
                  <div className="grid grid-cols-2 gap-2">
                    {(["engineering", "qa", "infra", "security"] as const).map((k) => {
                      const lim = lib?.capacityLimits[k] ?? [0, 8];
                      return (
                        <label key={k} className="flex items-center gap-2 text-xs"><span className="w-20">{k}</span>
                          <input type="number" min={lim[0]} max={lim[1]} value={draft.capacity?.[k] ?? sc?.initial.capacity[k] ?? 0} onChange={(e) => setDraft({ ...draft, capacity: { ...draft.capacity, [k]: Number(e.target.value) } })} className="input h-7 w-16" aria-label={`${k} capacity`} data-testid={`cap-${k}`} />
                        </label>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-2xs text-text-faint">Simulated slots only — real worker limits are not changed.</p>
                </div>
                <div className="flex flex-wrap gap-3 text-xs">
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.verificationGate} onChange={(e) => setDraft({ ...draft, verificationGate: e.target.checked })} /> Verification gate</label>
                  {scenarioId === "reliability_crisis" && <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!draft.useRollback} onChange={(e) => setDraft({ ...draft, useRollback: e.target.checked })} /> Use rollback (scenario only)</label>}
                  <label className="flex items-center gap-1.5">Risk policy
                    <select value={draft.riskPolicy} onChange={(e) => setDraft({ ...draft, riskPolicy: e.target.value as Decisions["riskPolicy"] })} className="input h-7 w-28">{["cautious", "balanced", "aggressive"].map((r) => <option key={r}>{r}</option>)}</select>
                  </label>
                </div>
                <p className="text-2xs text-text-faint">Risk policy only changes simulated approvals in the scenario; it never relaxes real permissions, approvals or the sandbox.</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button onClick={() => run("baseline")} disabled={!o.canRun || !!busy || allocSum !== 100} className="btn-secondary btn-sm" data-testid="run-baseline">{busy === "baseline" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run baseline</button>
                  <button onClick={() => run("what_if")} disabled={!o.canRun || !!busy || !baselineRun || allocSum !== 100} className="btn-primary btn-sm" title={baselineRun ? "Runs on an isolated copy of the latest baseline" : "Run a baseline first"} data-testid="run-whatif">{busy === "what_if" ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />} Run what-if vs baseline</button>
                  <button onClick={() => sc && setDraft(structuredClone(sc.defaults))} className="btn-ghost btn-sm">Reset to defaults</button>
                </div>
                {!o.canRun && <p className="text-2xs text-text-muted">Running simulations requires the member role.</p>}
              </div>
            )}
          </aside>
        </div>
      )}

      {tab === "compare" && <ComparePanel base={base} ids={cmp} companyId={id} canRun={o.canRun} />}
      {tab === "timeline" && <TimelinePanel base={base} runs={runs ?? []} companyId={id} />}
      {tab === "metrics" && <MetricsPanel metrics={o.metrics} />}
      {tab === "decisions" && <ConfigPanel base={base} o={o} onSaved={refetch} scenarioId={scenarioId} />}
    </div>
  );
}

function ComparePanel({ base, ids, companyId, canRun }: { base: string; ids: string[]; companyId: string; canRun: boolean }) {
  const { data: c, error } = useQuery<Compare>(ids.length >= 2 ? `${base}/compare?ids=${ids.join(",")}` : null);
  const [advice, setAdvice] = useState<{ mode: string; explanation?: string[]; advice?: { facts: { text: string; refs: string[] }[]; assumptions: string[]; forecasts: string[]; recommendations: string[]; uncertainties: string[] }; note: string } | null>(null);
  const [asking, setAsking] = useState(false);
  if (ids.length < 2) return <p className="text-sm text-text-muted">Select two or more runs in the Runs table (or run a what-if) to compare them.</p>;
  if (error) return <ErrorState message={error} />;
  if (!c) return <Skeleton className="h-60" />;
  async function ask() {
    setAsking(true);
    try {
      setAdvice(await fetchJSON(`${base}/advise`, { method: "POST", body: JSON.stringify({ question: "Explain why these runs differ and what to inspect next.", runIds: ids }) }));
    } finally {
      setAsking(false);
    }
  }
  return (
    <div className="space-y-5" data-testid="compare">
      <p className="text-xs text-warning">{c.caveat}</p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="table text-xs">
          <thead className="bg-bg-raised"><tr><th>Metric (simulated)</th>{c.runs.map((r) => <th key={r.id}>{r.label}</th>)}</tr></thead>
          <tbody>
            {c.runs[0].criteria.map((cr, i) => <tr key={cr.id}><td>{cr.text}</td>{c.runs.map((r) => <td key={r.id}>{r.criteria[i].met ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <XCircle className="h-3.5 w-3.5 text-danger" />}</td>)}</tr>)}
            {c.metrics.map((m) => <tr key={m.key} data-metric={m.key}><td className="text-text-muted">{m.label}</td>{m.values.map((v, i) => <td key={i} className={cn("mono", i > 0 && v !== m.values[0] && "text-brand")}>{v === null ? "—" : typeof v === "number" && !Number.isInteger(v) ? v.toFixed(3) : v}</td>)}</tr>)}
            <tr><td className="text-text-muted">Composite score <span className="text-text-faint">(see formula)</span></td>{c.runs.map((r) => <td key={r.id} className="mono" title={Object.entries(r.composite.components).map(([k, v]) => `${k}: ${v.value} × ${v.weight} = ${v.contribution}`).join("\n")}>{r.composite.score}</td>)}</tr>
          </tbody>
        </table>
      </div>
      <p className="mono text-2xs text-text-faint">composite = {c.runs[0].composite.formula}. It is a summary, not a verdict; inspect the criteria and components.</p>
      {c.decisionDiffs.map((d, i) => (
        <section key={d.runId} className="rounded-lg border border-border p-3 text-sm" data-testid="compare-explanation">
          <h3 className="font-medium">{c.runs[i + 1].label} vs {c.runs[0].label}</h3>
          <div className="metric-label mt-2">Decisions changed</div>
          <ul className="list-disc pl-5 text-xs">{d.diffs.length ? d.diffs.map((x) => <li key={x}>{x}</li>) : <li>No decision changed.</li>}</ul>
          <div className="metric-label mt-2">Why the results differ (from the run transitions)</div>
          <ul className="list-disc space-y-1 pl-5 text-xs text-text-muted">{c.explanations[i].notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </section>
      ))}
      <section className="rounded-lg border border-border p-3 text-sm">
        <div className="flex items-center gap-2"><h3 className="font-medium">Adviser</h3><Badge>AI interpretation · not authoritative</Badge>
          <button onClick={ask} disabled={!canRun || asking} className="btn-ghost btn-sm ml-auto">{asking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Explain</button>
        </div>
        {advice && (
          <div className="mt-2 text-xs" data-testid="advice">
            <p className="text-text-faint">{advice.note}</p>
            {advice.mode === "ai" && advice.advice ? (
              <div className="mt-1 grid gap-2 md:grid-cols-2">
                {(["facts", "assumptions", "forecasts", "recommendations", "uncertainties"] as const).map((k) => (
                  <div key={k}><div className="metric-label">{k}</div><ul className="list-disc pl-4">{(advice.advice![k] as unknown[]).map((x, i) => <li key={i}>{typeof x === "string" ? x : `${(x as { text: string }).text} [${(x as { refs: string[] }).refs.join(", ")}]`}</li>)}</ul></div>
                ))}
              </div>
            ) : <ul className="mt-1 list-disc pl-4">{advice.explanation?.map((x) => <li key={x}>{x}</li>)}</ul>}
          </div>
        )}
      </section>
      <p className="text-2xs text-text-faint">Inspect a run's events in the <Link className="underline" href={`/app/${companyId}/twin?tab=timeline`}>timeline</Link>.</p>
    </div>
  );
}

function TimelinePanel({ base, runs, companyId }: { base: string; runs: RunRow[]; companyId: string }) {
  const [prov, setProv] = useState<"" | "operational" | "simulation">("");
  const [dept, setDept] = useState("");
  const [run, setRun] = useState("");
  const [type, setType] = useState("");
  const qs = useMemo(() => new URLSearchParams(Object.entries({ provenance: prov, dept, run, type }).filter(([, v]) => v)).toString(), [prov, dept, run, type]);
  const { data } = useQuery<TimelineItem[]>(`${base}/timeline?${qs}`);
  const types = useMemo(() => [...new Set((data ?? []).map((d) => d.type))].sort(), [data]);
  return (
    <div data-testid="timeline">
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <div className="segmented" role="group" aria-label="Provenance">{(["", "operational", "simulation"] as const).map((p) => <button key={p} data-active={prov === p} onClick={() => setProv(p)}>{p || "all"}</button>)}</div>
        <select value={dept} onChange={(e) => setDept(e.target.value)} className="input h-7 w-40" aria-label="Department"><option value="">all departments</option>{["product", "engineering", "qa", "infra", "security", "company"].map((d) => <option key={d}>{d}</option>)}</select>
        <select value={run} onChange={(e) => setRun(e.target.value)} className="input h-7 w-56" aria-label="Simulation run"><option value="">all runs</option>{runs.map((r) => <option key={r.id} value={r.id}>{r.label} · {timeAgo(r.createdAt)}</option>)}</select>
        <select value={type} onChange={(e) => setType(e.target.value)} className="input h-7 w-44" aria-label="Event type"><option value="">all types</option>{types.map((t) => <option key={t}>{t}</option>)}</select>
      </div>
      {!data ? <Skeleton className="h-60" /> : data.length === 0 ? <p className="text-sm text-text-muted">No events match. Operational events appear as missions run; simulation events appear when you run a scenario.</p> : (
        <ol className="divide-y divide-border-subtle rounded-lg border border-border text-xs">
          {data.map((e) => (
            <li key={e.id} className="flex items-start gap-3 px-3 py-1.5" data-provenance={e.provenance} data-type={e.type}>
              <span className="mono w-20 shrink-0 text-text-faint">{e.simDay !== undefined ? `sim day ${e.simDay}` : timeAgo(e.at)}</span>
              <Badge tone={e.provenance === "operational" ? "success" : "warning"}>{e.provenance === "operational" ? "real" : "sim"}</Badge>
              <span className="mono w-20 shrink-0 text-text-faint">{e.dept ?? "—"}</span>
              <span className="mono w-28 shrink-0 text-text-muted">{e.type}</span>
              <span className="min-w-0 flex-1">{e.ref?.kind === "mission" ? <Link className="hover:underline" href={`/app/${companyId}/missions/${e.ref.id}`}>{e.text}</Link> : e.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function MetricsPanel({ metrics }: { metrics: Metric[] }) {
  return (
    <div data-testid="metrics">
      <p className="mb-3 text-xs text-text-muted">Operational metrics from persisted records (sample missions excluded). Simulated metrics are shown per run in Scenarios and Compare.</p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {metrics.map((m) => (
          <div key={m.key} className="rounded-lg border border-border p-3" data-metric={m.key}>
            <div className="flex items-center gap-2"><span className="metric-label">{m.label}</span><Badge tone="success">{m.kind}</Badge></div>
            <div className={cn("mono mt-1 text-lg", m.value === null && "text-sm text-text-faint")}>{fmt(m)}</div>
            <p className="mt-1 text-2xs text-text-muted">{m.definition}</p>
            <p className="mono mt-1 text-2xs text-text-faint">source {m.source} · {m.window} · n={m.sample}{m.note ? ` · ${m.note}` : ""}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfigPanel({ base, o, onSaved, scenarioId }: { base: string; o: Overview; onSaved: () => void; scenarioId: string }) {
  const { toast } = useApp();
  const [riskPolicy, setRiskPolicy] = useState(o.config.riskPolicy);
  const [priorities, setPriorities] = useState(o.config.priorities);
  const [preview, setPreview] = useState<{ current: Record<string, number>; proposed: Record<string, number> } | null>(null);
  const patch = { riskPolicy, priorities };
  async function doPreview() {
    setPreview(await fetchJSON(`${base}/config`, { method: "POST", body: JSON.stringify({ scenario: scenarioId, patch }) }));
  }
  async function apply() {
    try {
      await fetchJSON(`${base}/config`, { method: "PUT", body: JSON.stringify({ ...patch, expectedVersion: o.config.version }) });
      toast({ title: "Company policy updated", description: "Simulated configuration; real permissions are unchanged.", level: "success" });
      setPreview(null);
      onSaved();
    } catch (e) {
      toast({ title: "Not applied", description: (e as Error).message, level: "danger" });
    }
  }
  return (
    <div className="grid gap-5 lg:grid-cols-2" data-testid="config">
      <section className="rounded-lg border border-border p-4 text-sm">
        <div className="flex items-center gap-2"><h3 className="font-medium">Company operating policy</h3><Badge tone="warning">simulation config · v{o.config.version}</Badge></div>
        <p className="mt-1 text-xs text-text-muted">Defaults for new scenario runs. Changing them never alters real worker limits, tool permissions, approvals or the sandbox.</p>
        <div className="metric-label mb-1 mt-3">Strategic priorities</div>
        <ol className="space-y-1 text-xs">{priorities.map((p, i) => <li key={p} className="flex items-center gap-2"><span className="mono w-4">{i + 1}</span><span className="flex-1">{PRIORITY_LABEL[p]}</span><button className="icon-btn h-5 w-5" disabled={i === 0} aria-label={`Raise ${PRIORITY_LABEL[p]}`} onClick={() => { const n = [...priorities]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setPriorities(n); }}>↑</button></li>)}</ol>
        <label className="mt-3 flex items-center gap-2 text-xs">Risk policy<select value={riskPolicy} onChange={(e) => setRiskPolicy(e.target.value as Decisions["riskPolicy"])} className="input h-7 w-28">{["cautious", "balanced", "aggressive"].map((r) => <option key={r}>{r}</option>)}</select></label>
        <div className="mt-3 flex gap-2">
          <button onClick={doPreview} className="btn-secondary btn-sm">Preview impact ({scenarioId.replace(/_/g, " ")})</button>
          <button onClick={apply} disabled={!o.canDecide} className="btn-primary btn-sm">Apply decision</button>
        </div>
        {!o.canDecide && <p className="mt-1 text-2xs text-text-muted">Applying requires the admin role.</p>}
        {preview && (
          <table className="table mt-3 text-xs" data-testid="preview">
            <thead><tr><th>Simulated metric</th><th>Current</th><th>Proposed</th></tr></thead>
            <tbody>{Object.keys(preview.current).map((k) => <tr key={k}><td>{k}</td><td className="mono">{preview.current[k]}</td><td className={cn("mono", preview.current[k] !== preview.proposed[k] && "text-brand")}>{preview.proposed[k]}</td></tr>)}</tbody>
          </table>
        )}
      </section>
      <section className="rounded-lg border border-border p-4 text-sm">
        <h3 className="font-medium">Decision history</h3>
        {o.config.history.length === 0 ? <p className="mt-1 text-xs text-text-muted">No decisions yet.</p> : (
          <ol className="mt-2 space-y-1 text-xs">{[...o.config.history].reverse().map((h) => <li key={h.version} className="flex gap-2"><Circle className="mt-1 h-2.5 w-2.5 shrink-0 text-text-faint" /><span><span className="mono">v{h.version}</span> {h.change} <span className="text-text-faint">· {h.by} · {timeAgo(h.at)}</span></span></li>)}</ol>
        )}
      </section>
    </div>
  );
}

"use client";

/**
 * Adaptive execution (V16) tab: the persisted execution plan of each run —
 * classification with evidence, chosen strategy and why, plan steps, required
 * vs executed checks, tools, model route, strategy changes — plus the
 * project's execution policy and strategy metrics measured from finished runs.
 * Everything shown is a stored decision; the policy form calls the ADMIN-only
 * backend route (the server enforces the role, this UI only hides the form).
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useQuery, fetchJSON } from "@/hooks/useApi";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { formatCurrency, timeAgo } from "@/lib/utils";

type Tone = "success" | "warning" | "danger" | "neutral" | "info";
const label = (s: string) => s.replace(/_/g, " ");
const RUN_TONE: Record<string, Tone> = { VERIFIED: "success", FAILED: "danger", BLOCKED: "warning", RUNNING: "info", QUEUED: "neutral", CANCELLED: "neutral" };
const CHECK_TONE: Record<string, Tone> = { passed: "success", failed: "danger", unavailable: "warning", not_run: "warning" };

interface Dim { value: string | number | boolean; evidence: string[] }
interface Plan {
  policy?: string; adaptive?: boolean; createdAt?: string;
  classification?: Record<string, Dim> & { confidence: number; fastPath: boolean; ambiguity: { blocking: boolean; questions: string[] } };
  strategy?: { strategy: string; why: string; steps: { key: string; title: string; agent: string; dependsOn: string[]; parallel: boolean; gate?: string }[]; completion: string[] };
  owner?: { agent: string; why: string; limitation?: string };
  verification?: { id: string; why: string }[];
  verificationStatus?: { attempt: number; rows: { id: string; status: string }[]; verified: boolean; unverified: string[]; failed: string[] };
  tools?: { tool: string; why: string; available: boolean; permitted: boolean }[];
  model?: { tier: string; model: string | null; fallbackUsed: boolean; reasons: string[]; blocker: string | null };
  collaboration?: { worth: boolean; why: string };
  adjustments?: { attempt: number; action: string; blocker: string; rationale: string; source: string; applied: string; at: string }[];
}
interface Row { runs: number; verified: number; firstAttempt: number; blocked: number; attempts: number; costUsd: number; modelCalls: number; adjustments: number }
interface Data {
  policy: { adaptivePolicy?: string; pinnedStrategy?: string; mandatoryChecks?: string[]; allowedProviders?: string[]; pinnedModels?: string[]; fallback?: string };
  effective: string;
  policies: { id: string; description: string; adaptive: boolean }[];
  strategies: string[];
  checks: string[];
  models: { provider: string; model: string; tier: string; available: boolean }[];
  runs: { id: string; itemKey: string; status: string; attempt: number; costUsd: number; modelCalls: number; stopReason: string; adaptivePolicy: string; createdAt: string; plan: Plan }[];
  metrics: { byPolicy: Record<string, Row>; byStrategy: Record<string, Row & { policy: string }> };
}

const DIMS = ["category", "scope", "complexity", "uncertainty", "familiarity", "research", "risk", "verificationDepth", "collaboration"] as const;

export function ExecutionTab({ base, isAdmin, openRun }: { base: string; isAdmin: boolean; openRun: (id: string) => void }) {
  const { data, error, refetch } = useQuery<Data>(`${base}/execution`, 15000);
  const [sel, setSel] = useState<string | null>(null);
  if (error) return <p className="text-sm text-danger">Execution view unavailable: {error}</p>;
  if (!data) return <Skeleton className="h-60" />;
  const run = data.runs.find((r) => r.id === sel) ?? data.runs[0];
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
  return (
    <div className="space-y-5" data-testid="execution">
      <section>
        <div className="metric-label mb-1">Strategy results by policy <span className="text-text-faint">(measured from finished runs of this product)</span></div>
        {Object.keys(data.metrics.byPolicy).length ? (
          <table className="w-full text-xs">
            <thead className="text-left text-text-muted"><tr><th className="py-1">Policy / strategy</th><th>Runs</th><th>Verified</th><th>First attempt</th><th>Blocked</th><th>Attempts</th><th>Model calls</th><th>Est. cost</th><th>Strategy changes</th></tr></thead>
            <tbody>
              {Object.entries(data.metrics.byPolicy).map(([p, m]) => (
                <tr key={p} className="border-t border-border-subtle font-medium"><td className="py-1 mono">{p}</td><td>{m.runs}</td><td>{m.verified} ({pct(m.verified, m.runs)})</td><td>{m.firstAttempt} ({pct(m.firstAttempt, m.runs)})</td><td>{m.blocked}</td><td>{m.attempts}</td><td>{m.modelCalls}</td><td>{formatCurrency(m.costUsd)}</td><td>{m.adjustments}</td></tr>
              ))}
              {Object.entries(data.metrics.byStrategy).map(([k, m]) => (
                <tr key={k} className="text-text-muted"><td className="py-0.5 pl-4 mono">{label(k.split(":")[1])}</td><td>{m.runs}</td><td>{m.verified}</td><td>{m.firstAttempt}</td><td>{m.blocked}</td><td>{m.attempts}</td><td>{m.modelCalls}</td><td>{formatCurrency(m.costUsd)}</td><td>{m.adjustments}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-xs text-text-muted">No finished runs with an execution plan yet.</p>}
      </section>

      <section>
        <div className="metric-label mb-1">Runs ({data.runs.length})</div>
        {data.runs.length ? (
          <div className="flex flex-wrap gap-1.5">{data.runs.map((r) => (
            <button key={r.id} onClick={() => setSel(r.id)} data-active={run?.id === r.id} className="rounded-md border border-border px-2 py-1 text-xs data-[active=true]:border-brand/50">
              <span className="mono">{r.itemKey}</span> <Badge tone={RUN_TONE[r.status] ?? "neutral"}>{r.status.toLowerCase()}</Badge> <span className="text-text-faint">{r.plan.strategy ? label(r.plan.strategy.strategy) : "no plan"}</span>
            </button>
          ))}</div>
        ) : <p className="text-xs text-text-muted">No run has been planned yet. Plans are created when an engineering run starts.</p>}
      </section>

      {run && <PlanView run={run} openRun={openRun} />}

      <PolicyForm data={data} isAdmin={isAdmin} base={base} onSaved={refetch} />
    </div>
  );
}

function PlanView({ run, openRun }: { run: Data["runs"][number]; openRun: (id: string) => void }) {
  const p = run.plan;
  const c = p.classification;
  return (
    <section className="space-y-3 rounded-md border border-border p-3" data-testid="execution-plan">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button className="mono underline" onClick={() => openRun(run.id)}>{run.itemKey}</button>
        <Badge tone={RUN_TONE[run.status] ?? "neutral"}>{run.status.toLowerCase()}</Badge>
        <Badge tone="info">{p.strategy ? label(p.strategy.strategy) : "—"}</Badge>
        <span className="text-xs text-text-faint">policy {p.policy}{p.adaptive === false ? " (one strategy for every task)" : ""} · {run.attempt + 1} attempt(s) · {run.modelCalls} model calls · {formatCurrency(run.costUsd)}{run.stopReason ? ` · stopped: ${label(run.stopReason)}` : ""} · planned {p.createdAt ? timeAgo(p.createdAt) : "—"}</span>
      </div>
      {p.strategy && <p className="text-sm"><span className="font-medium">Why this strategy:</span> {p.strategy.why}</p>}
      {c && (
        <div>
          <div className="metric-label mb-1">Classification <span className="text-text-faint">(confidence {Math.round(c.confidence * 100)}%{c.fastPath ? ", fast path" : ""})</span></div>
          <ul className="grid gap-1 text-xs sm:grid-cols-2">{DIMS.filter((d) => c[d]).map((d) => (
            <li key={d}><span className="font-medium">{label(d)}:</span> {String(c[d].value)} <span className="text-text-faint">— {c[d].evidence.join("; ")}</span></li>
          ))}</ul>
          {c.ambiguity.questions.length > 0 && <p className="mt-1 text-xs text-warning">{c.ambiguity.blocking ? "Blocking ambiguity" : "Open questions"}: {c.ambiguity.questions.join(" ")}</p>}
        </div>
      )}
      {p.owner && <p className="text-xs"><span className="font-medium">Owner:</span> {p.owner.agent} — {p.owner.why}{p.owner.limitation ? <span className="text-warning"> (limitation: {p.owner.limitation})</span> : null}</p>}
      {p.strategy && (
        <div>
          <div className="metric-label mb-1">Plan steps</div>
          <ol className="list-decimal space-y-0.5 pl-5 text-xs">{p.strategy.steps.map((s) => <li key={s.key}><span className="font-medium">{s.title}</span> <span className="text-text-faint">[{s.agent}{s.parallel ? ", parallel" : ""}{s.dependsOn.length ? `, after ${s.dependsOn.join(", ")}` : ""}{s.gate ? `, gate: ${s.gate}` : ""}]</span></li>)}</ol>
        </div>
      )}
      {p.verification && (
        <div>
          <div className="metric-label mb-1">Verification — required vs executed {p.verificationStatus ? <span className="text-text-faint">(attempt {p.verificationStatus.attempt + 1}: {p.verificationStatus.verified ? "all required checks passed" : `unverified: ${[...p.verificationStatus.failed, ...p.verificationStatus.unverified].map(label).join(", ") || "—"}`})</span> : <span className="text-text-faint">(nothing executed yet)</span>}</div>
          <ul className="flex flex-wrap gap-1.5 text-xs">{p.verification.map((v) => {
            const st = p.verificationStatus?.rows.find((r) => r.id === v.id)?.status ?? "not_run";
            return <li key={v.id} title={v.why}><Badge tone={CHECK_TONE[st] ?? "neutral"}>{label(v.id)}: {label(st)}</Badge></li>;
          })}</ul>
        </div>
      )}
      {p.tools && <p className="text-xs"><span className="font-medium">Tools:</span> {p.tools.map((t) => `${t.tool}${!t.available ? " (unavailable)" : !t.permitted ? " (not permitted)" : ""}`).join(", ")}</p>}
      {p.model && <p className="text-xs"><span className="font-medium">Model route:</span> {p.model.blocker ? <span className="text-danger">blocked — {p.model.blocker}</span> : `${p.model.model ?? "—"} (${p.model.tier}${p.model.fallbackUsed ? ", fallback" : ""})`} <span className="text-text-faint">{p.model.reasons.join("; ")}</span></p>}
      {p.collaboration && <p className="text-xs"><span className="font-medium">Collaboration:</span> {p.collaboration.worth ? "parallel parts worth it" : "single owner"} <span className="text-text-faint">— {p.collaboration.why}</span></p>}
      <div>
        <div className="metric-label mb-1">Strategy changes during the run ({p.adjustments?.length ?? 0})</div>
        {p.adjustments?.length ? <ul className="space-y-1 text-xs">{p.adjustments.map((a, i) => <li key={i}><Badge tone={a.action === "stop" ? "danger" : "warning"}>{label(a.action)}</Badge> after attempt {a.attempt + 1}: {a.rationale} <span className="text-text-faint">(evidence: {a.blocker}; source {a.source}; applied: {a.applied})</span></li>)}</ul> : <p className="text-xs text-text-muted">None — the plan ran as chosen.</p>}
      </div>
    </section>
  );
}

function PolicyForm({ data, isAdmin, base, onSaved }: { data: Data; isAdmin: boolean; base: string; onSaved: () => void }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState(data.policy.adaptivePolicy ?? "");
  const [pinned, setPinned] = useState(data.policy.pinnedStrategy ?? "");
  const [checks, setChecks] = useState<string[]>(data.policy.mandatoryChecks ?? []);
  const [fallback, setFallback] = useState(data.policy.fallback ?? "fallback");
  const save = async () => {
    setBusy(true);
    try {
      await fetchJSON(`${base}/execution`, { method: "PATCH", body: JSON.stringify({ adaptivePolicy: policy, pinnedStrategy: pinned || null, mandatoryChecks: checks, fallback }) });
      toast({ title: "Execution policy saved — applies to runs started from now on", level: "success" });
      onSaved();
    } catch (e) {
      toast({ title: "Not saved", description: (e as Error).message, level: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section data-testid="execution-policy">
      <div className="metric-label mb-1">Execution policy <span className="text-text-faint">(effective: {data.effective})</span></div>
      <ul className="mb-2 space-y-0.5 text-xs text-text-muted">{data.policies.map((p) => <li key={p.id}><span className="mono text-text">{p.id}</span> — {p.description}</li>)}</ul>
      <p className="mb-2 text-xs text-text-muted">Configured models: {data.models.map((m) => `${m.model} (${m.tier}, ${m.available ? "available" : "unavailable"})`).join(", ")}. Allowed providers: {data.policy.allowedProviders?.join(", ") || "any configured"}.</p>
      {isAdmin ? (
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="flex flex-col gap-1">Policy<select className="input" value={policy} onChange={(e) => setPolicy(e.target.value)}><option value="">default</option>{data.policies.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}</select></label>
          <label className="flex flex-col gap-1">Pinned strategy<select className="input" value={pinned} onChange={(e) => setPinned(e.target.value)}><option value="">adaptive (none)</option>{data.strategies.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></label>
          <label className="flex flex-col gap-1">Model fallback<select className="input" value={fallback} onChange={(e) => setFallback(e.target.value)}><option value="fallback">fall back within approved providers</option><option value="fail">fail instead</option></select></label>
          <fieldset className="flex flex-wrap gap-2"><legend className="mb-1">Mandatory checks</legend>{data.checks.map((c) => <label key={c} className="flex items-center gap-1"><input type="checkbox" checked={checks.includes(c)} onChange={(e) => setChecks(e.target.checked ? [...checks, c] : checks.filter((x) => x !== c))} />{label(c)}</label>)}</fieldset>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Save policy</button>
        </div>
      ) : <p className="text-xs text-text-faint">Only workspace admins can change the execution policy.</p>}
    </section>
  );
}

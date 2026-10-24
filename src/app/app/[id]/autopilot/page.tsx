"use client";

/**
 * Autopilot control plane: goals, jobs, workers, schedules, alerts and the
 * kill switch — all read from /api/companies/[id]/runtime/*. Worker status is
 * derived from persisted heartbeats; an offline worker is shown as offline.
 * No progress bars or activity are synthesized.
 */
import { use, useState } from "react";
import { Power, Pause, Play, Square, RotateCcw, Plus } from "lucide-react";
import { useQuery, fetchJSON } from "@/hooks/useApi";
import { PageHeader, Skeleton, Badge, ErrorState } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { timeAgo } from "@/lib/utils";

interface Worker { id: string; host: string; mode: string; status: string; online: boolean; heartbeatAt: string; heartbeatAgeMs: number; running: number; processed: number; failed: number; startedAt: string; version: string }
interface Overview {
  role: string;
  settings: { autonomyEnabled: boolean; globalAutonomyEnabled: boolean; limits: { maxConcurrentJobs: number; maxConcurrentPerKey: number }; updatedBy: string };
  workers: Worker[];
  metrics: { windowHours: number; jobs: { byStatus: Record<string, number>; finished: number; successRate: number | null; retries: number; p50Ms: number | null; p95Ms: number | null; failureKinds: Record<string, number> }; queue: { dueNow: number; oldestWaitMs: number | null }; recovery: Record<string, number>; provider: { failures: number }; tests: { runs: number; passRate: number | null }; cost: { estimatedUsd: number; source: string }; breakers: { scope: string; state: string; failures: number; reason: string; reopenAt: string | null }[]; goals: Record<string, number>; experiments: Record<string, number>; schedules: { id: string; name: string; jobType: string; spec: string; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null; runs: number }[] };
  alerts: { key: string; severity: string; title: string; detail: string }[];
}
interface Goal { id: string; kind: string; title: string; mode: string; status: string; statusReason: string; plan: { key: string; title: string; status: string; evidence?: string }[]; acceptance: { id: string; text: string; status: string; evidence: string }[]; usage: { advances: number; modelCalls: number; costUsd: number; costSource: string; wallMs: number }; limits: Record<string, number>; checkpoint: { step?: string; productId?: string }; nextCheckAt: string | null; createdAt: string; finishedAt: string | null }
interface Job { id: string; type: string; status: string; priority: number; attempts: number; maxAttempts: number; runAt: string; startedAt: string | null; finishedAt: string | null; workerId: string | null; lastError: string; errorKind: string | null; progress: string; goalId: string | null }

const TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = { COMPLETED: "success", SUCCEEDED: "success", RUNNING: "info", QUEUED: "neutral", WAITING: "warning", PAUSED: "neutral", BLOCKED: "warning", BUDGET_EXHAUSTED: "warning", FAILED: "danger", DEAD: "danger", CANCELLED: "neutral" };
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const dur = (ms: number | null) => (ms == null ? "—" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

export default function Autopilot({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const base = `/api/companies/${id}/runtime`;
  const { toast } = useApp();
  const { data: o, error, refetch } = useQuery<Overview>(base, 5000);
  const { data: goals, refetch: refetchGoals } = useQuery<Goal[]>(`${base}/goals`, 5000);
  const [jobFilter, setJobFilter] = useState("");
  const { data: jobs, refetch: refetchJobs } = useQuery<Job[]>(`${base}/jobs${jobFilter ? `?status=${jobFilter}` : ""}`, 5000);
  const [form, setForm] = useState({ kind: "build_product", mode: "SUPERVISED", request: "", schedule: "", maxCostUsd: 5 });
  async function post(label: string, url: string, body: unknown) {
    try {
      await fetchJSON(url, { method: "POST", body: JSON.stringify(body) });
      toast({ title: label, level: "success" });
      refetch(); refetchGoals(); refetchJobs();
    } catch (e) {
      toast({ title: `${label} failed`, description: (e as Error).message, level: "danger" });
    }
  }
  if (error) return <div className="page"><ErrorState message={`Runtime unavailable: ${error}`} onRetry={refetch} /></div>;
  if (!o) return <div className="page"><Skeleton className="h-80" /></div>;
  const isAdmin = ["OWNER", "ADMIN"].includes(o.role);
  const online = o.workers.filter((w) => w.online);
  const autonomyOn = o.settings.autonomyEnabled && o.settings.globalAutonomyEnabled;
  return (
    <div className="page space-y-6" data-testid="autopilot">
      <PageHeader title="Autopilot" description="Autonomous goals and the durable runtime that executes them. Everything shown is persisted state; work continues only while a worker process is running." />

      <section className="grid gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-border p-3" data-testid="autonomy" data-enabled={autonomyOn}>
          <div className="metric-label">Autonomous execution</div>
          <div className="mt-1 flex items-center gap-2 text-sm font-medium">{autonomyOn ? "Enabled" : "Disabled"}{!o.settings.globalAutonomyEnabled && <Badge tone="danger">global stop</Badge>}</div>
          {isAdmin && <button data-testid="kill-switch" className={autonomyOn ? "btn-danger btn-sm mt-2" : "btn-secondary btn-sm mt-2"} onClick={() => (autonomyOn ? window.confirm("Stop all autonomous execution in this workspace now? Running goals are paused and their jobs cancelled.") && post("Autonomy disabled", base, { action: "autonomy", enabled: false, reason: "kill switch" }) : post("Autonomy enabled", base, { action: "autonomy", enabled: true }))}><Power className="h-3 w-3" /> {autonomyOn ? "Disable now" : "Enable"}</button>}
          {o.settings.updatedBy && <p className="mt-1 text-2xs text-text-faint">last changed by {o.settings.updatedBy}</p>}
        </div>
        <div className="rounded-lg border border-border p-3" data-testid="workers-summary" data-online={online.length}>
          <div className="metric-label">Workers online</div>
          <div className="mt-1 text-sm font-medium">{online.length} / {o.workers.length}</div>
          <p className="text-2xs text-text-faint">{online.length ? `newest heartbeat ${dur(online[0].heartbeatAgeMs)} ago` : "No worker is heart-beating: queued work will not run. Start one with `npm run worker`."}</p>
        </div>
        <div className="rounded-lg border border-border p-3"><div className="metric-label">Queue</div><div className="mt-1 text-sm font-medium">{o.metrics.queue.dueNow} due now</div><p className="text-2xs text-text-faint">oldest waiting {dur(o.metrics.queue.oldestWaitMs)} · limit {o.settings.limits.maxConcurrentJobs} concurrent</p></div>
        <div className="rounded-lg border border-border p-3"><div className="metric-label">Last {o.metrics.windowHours} h</div><div className="mt-1 text-sm font-medium">{o.metrics.jobs.finished} jobs · {pct(o.metrics.jobs.successRate)} succeeded</div><p className="text-2xs text-text-faint">p50 {dur(o.metrics.jobs.p50Ms)} · p95 {dur(o.metrics.jobs.p95Ms)} · {o.metrics.jobs.retries} retries · tests {pct(o.metrics.tests.passRate)} of {o.metrics.tests.runs} · est. ${o.metrics.cost.estimatedUsd.toFixed(4)}</p></div>
      </section>

      {o.alerts.length > 0 && <section data-testid="alerts" className="space-y-1">{o.alerts.map((a) => <p key={a.key} role="alert" className={`rounded border px-3 py-2 text-xs ${a.severity === "high" ? "border-danger/40 bg-danger/5" : "border-warning/40 bg-warning/5"}`}><strong>{a.title}.</strong> {a.detail}</p>)}</section>}

      <section>
        <h2 className="mb-2 text-sm font-medium">New goal</h2>
        <div className="grid gap-2 md:grid-cols-[160px_190px_minmax(0,1fr)_150px_100px_auto] text-xs">
          <select className="input h-8" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label="Goal kind"><option value="build_product">Build a product</option><option value="add_feature">Add a feature</option><option value="improve_aura">Improve AURA</option></select>
          <select className="input h-8" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })} aria-label="Mode"><option value="SUPERVISED">Supervised</option><option value="AUTONOMOUS_DEV">Autonomous development</option><option value="CONTINUOUS_IMPROVEMENT">Continuous improvement</option></select>
          <input className="input h-8" placeholder="Describe the outcome you want" value={form.request} onChange={(e) => setForm({ ...form, request: e.target.value })} aria-label="Request" />
          <input className="input h-8" placeholder="Schedule (optional): every 1d" value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} aria-label="Schedule" />
          <input className="input h-8" type="number" min={0.01} step={0.5} value={form.maxCostUsd} onChange={(e) => setForm({ ...form, maxCostUsd: Number(e.target.value) })} aria-label="Cost limit (USD, estimated)" title="Estimated cost limit (USD)" />
          <button className="btn-primary btn-sm" data-testid="submit-goal" onClick={() => post(form.schedule ? "Goal scheduled" : "Goal submitted", `${base}/goals`, { kind: form.kind, mode: form.mode, request: form.request, schedule: form.schedule || undefined, limits: { maxCostUsd: form.maxCostUsd } })}><Plus className="h-3 w-3" /> Submit</button>
        </div>
        <p className="mt-1 text-2xs text-text-faint">Supervised: AURA asks before consequential steps. Autonomous development (admin): AURA approves its own plan and builds on isolated branches; publishing and deployment still need a person. Continuous improvement (admin): lab experiments on AURA's own methods, results proposed for review.</p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Goals</h2>
        {!goals ? <Skeleton className="h-20" /> : !goals.length ? <p className="text-xs text-text-muted">No goals yet.</p> : (
          <ul className="space-y-2" data-testid="goals">{goals.map((g) => (
            <li key={g.id} className="rounded-lg border border-border p-3 text-xs" data-goal={g.id} data-status={g.status}>
              <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{g.title}</span><Badge tone={TONE[g.status] ?? "neutral"}>{g.status.toLowerCase().replace("_", " ")}</Badge><Badge tone="neutral">{g.mode.toLowerCase().replace("_", " ")}</Badge><span className="mono text-text-faint">{g.kind}</span><span className="ml-auto text-text-faint">{timeAgo(g.createdAt)}</span></div>
              {g.statusReason && <p className="mt-1 text-text-muted" role="status">{g.statusReason}</p>}
              <ol className="mt-2 space-y-0.5">{g.plan.map((s) => <li key={s.key} className="flex gap-2"><Badge tone={s.status === "done" ? "success" : s.status === "failed" ? "danger" : s.status === "running" ? "info" : s.status === "waiting" ? "warning" : "neutral"}>{s.status}</Badge><span>{s.title}</span>{s.evidence && <span className="text-text-faint">— {s.evidence}</span>}</li>)}</ol>
              {g.acceptance.length > 0 && <ul className="mt-2 space-y-0.5">{g.acceptance.map((a) => <li key={a.id}><span className="mono">{a.id}</span> {a.text} — <strong>{a.status.replace("_", " ")}</strong> <span className="text-text-faint">({a.evidence})</span></li>)}</ul>}
              <p className="mono mt-2 text-2xs text-text-faint">{g.usage.advances} step(s) · {g.usage.modelCalls} model calls · ${g.usage.costUsd?.toFixed?.(4) ?? "0"} ({g.usage.costSource || "no usage yet"}) of ${g.limits.maxCostUsd} · {dur(g.usage.wallMs)}{g.nextCheckAt && !g.finishedAt ? ` · next step ${timeAgo(g.nextCheckAt)}` : ""}{g.checkpoint.step ? ` · checkpoint: ${g.checkpoint.step}` : ""}</p>
              <div className="mt-2 flex gap-2">
                {["QUEUED", "RUNNING", "WAITING"].includes(g.status) && <button className="btn-ghost btn-sm" onClick={() => post("Goal paused", `${base}/goals/${g.id}`, { action: "pause" })}><Pause className="h-3 w-3" /> Pause</button>}
                {["PAUSED", "BLOCKED", "FAILED"].includes(g.status) && <button className="btn-secondary btn-sm" onClick={() => post("Goal resumed", `${base}/goals/${g.id}`, { action: "resume" })}><Play className="h-3 w-3" /> Resume from checkpoint</button>}
                {g.status === "BUDGET_EXHAUSTED" && <button className="btn-secondary btn-sm" onClick={() => { const v = window.prompt("New cost limit (USD, estimated)", String((g.limits.maxCostUsd ?? 5) * 2)); if (v) post("Goal resumed with a higher limit", `${base}/goals/${g.id}`, { action: "resume", limits: { maxCostUsd: Number(v), maxAdvances: (g.limits.maxAdvances ?? 200) * 2 } }); }}><Play className="h-3 w-3" /> Raise limits & resume</button>}
                {!["COMPLETED", "FAILED", "CANCELLED", "BUDGET_EXHAUSTED"].includes(g.status) && <button className="btn-ghost btn-sm" onClick={() => window.confirm("Cancel this goal and its running work?") && post("Goal cancelled", `${base}/goals/${g.id}`, { action: "cancel" })}><Square className="h-3 w-3" /> Cancel</button>}
                {g.checkpoint.productId && <a className="btn-ghost btn-sm" href={`/app/${id}/products/${g.checkpoint.productId}`}>Open product</a>}
              </div>
            </li>
          ))}</ul>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2"><h2 className="text-sm font-medium">Jobs</h2>
          <select className="input h-7 w-auto text-xs" value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} aria-label="Job status filter"><option value="">all</option>{["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "DEAD", "CANCELLED"].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</select>
          {isAdmin && <button className="btn-ghost btn-sm" onClick={() => post("Ping queued — a worker will answer it if one is running", base, { action: "ping" })}>Send ping job</button>}
        </div>
        <div className="overflow-x-auto"><table className="table text-xs" data-testid="jobs"><thead><tr><th>Type</th><th>Status</th><th>Attempts</th><th>Priority</th><th>Run at</th><th>Worker</th><th>Progress / error</th><th /></tr></thead><tbody>
          {(jobs ?? []).map((j) => { const p = (() => { try { return JSON.parse(j.progress) as { step?: string; message?: string }; } catch { return {}; } })(); return (
            <tr key={j.id} data-job={j.id} data-status={j.status}><td className="mono">{j.type}</td><td><Badge tone={TONE[j.status] ?? "neutral"}>{j.status.toLowerCase()}</Badge></td><td>{j.attempts}/{j.maxAttempts}</td><td>{j.priority}</td><td>{timeAgo(j.runAt)}</td><td className="mono text-2xs">{j.workerId?.slice(-12) ?? "—"}</td><td className="max-w-md truncate" title={j.lastError || p.message}>{j.lastError ? `${j.errorKind}: ${j.lastError}` : p.step ? `${p.step}${p.message ? `: ${p.message}` : ""}` : "—"}</td>
              <td>{["FAILED", "DEAD", "CANCELLED"].includes(j.status) && <button className="btn-ghost btn-sm" onClick={() => post("Job retried from its checkpoint", `${base}/jobs/${j.id}`, { action: "retry" })}><RotateCcw className="h-3 w-3" /></button>}{["QUEUED", "RUNNING"].includes(j.status) && <button className="btn-ghost btn-sm" onClick={() => post("Job cancelled", `${base}/jobs/${j.id}`, { action: "cancel" })}><Square className="h-3 w-3" /></button>}</td></tr>
          ); })}
        </tbody></table></div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div>
          <h2 className="mb-2 text-sm font-medium">Workers</h2>
          <ul className="space-y-1 text-xs" data-testid="workers">{o.workers.map((w) => <li key={w.id} className="flex flex-wrap gap-2" data-worker={w.id} data-online={w.online}><Badge tone={w.online ? "success" : "neutral"}>{w.online ? "online" : w.status === "STOPPED" ? "stopped" : "offline"}</Badge><span className="mono">{w.id}</span><span className="text-text-faint">{w.mode} · heartbeat {timeAgo(w.heartbeatAt)} · running {w.running} · {w.processed} done / {w.failed} failed</span></li>)}{!o.workers.length && <li className="text-text-muted">No worker has ever registered.</li>}</ul>
        </div>
        <div>
          <h2 className="mb-2 text-sm font-medium">Schedules & circuit breakers</h2>
          <ul className="space-y-1 text-xs">{o.metrics.schedules.map((s) => <li key={s.id}><Badge tone={s.enabled ? "info" : "neutral"}>{s.enabled ? "enabled" : "off"}</Badge> {s.name} <span className="mono text-text-faint">{s.jobType} · {s.spec} · next {s.nextRunAt ? new Date(s.nextRunAt).toISOString().replace(".000Z", "Z") : "—"} · {s.runs} run(s)</span>{isAdmin && <button className="btn-ghost btn-sm ml-1" onClick={() => post(s.enabled ? "Schedule disabled" : "Schedule enabled", `${base}/schedules/${s.id}`, { action: s.enabled ? "disable" : "enable" })}>{s.enabled ? "Disable" : "Enable"}</button>}</li>)}{!o.metrics.schedules.length && <li className="text-text-muted">No schedules.</li>}</ul>
          {isAdmin && <button className="btn-ghost btn-sm mt-1" onClick={() => post("Daily improvement cycle scheduled", `${base}/schedules`, { name: "Daily AURA improvement cycle", jobType: "lab.cycle", spec: "17 3 * * *" })}>Schedule a daily improvement cycle (03:17 UTC)</button>}
          <ul className="mt-2 space-y-1 text-xs">{o.metrics.breakers.map((b) => <li key={b.scope}><Badge tone={b.state === "OPEN" ? "danger" : "warning"}>{b.state.toLowerCase()}</Badge> <span className="mono">{b.scope}</span> — {b.failures} failures: {b.reason}{isAdmin && <button className="btn-ghost btn-sm ml-1" onClick={() => post("Breaker reset", base, { action: "reset_breaker", scope: b.scope })}>Reset</button>}</li>)}</ul>
          <p className="mt-2 text-2xs text-text-faint">Recovery last {o.metrics.windowHours} h: {o.metrics.recovery.leaseReclaimed} reclaimed after a worker died · {o.metrics.recovery.released} released on shutdown · {o.metrics.recovery.timeouts} timeouts · {o.metrics.recovery.checkpoints} checkpoints · provider failures {o.metrics.provider.failures} · experiments {Object.entries(o.metrics.experiments).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(", ") || "none"}. {o.metrics.cost.source}.</p>
        </div>
      </section>
    </div>
  );
}

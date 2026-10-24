"use client";

/**
 * Integration & reliability (V13) and Product evolution (V14) tabs. Everything
 * shown comes from stored records via the product routes; every button calls
 * a backend action that enforces authorization and policy.
 */
import { useState } from "react";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { useQuery, fetchJSON } from "@/hooks/useApi";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { cn, timeAgo } from "@/lib/utils";

type Tone = "success" | "warning" | "danger" | "neutral" | "info";
const STATUS_TONE: Record<string, Tone> = { RESOLVED: "success", LIMITATION: "warning", UNRESOLVED: "danger", OPEN: "info", REPAIRING: "info", APPROVED: "info", IN_PROGRESS: "info", DONE: "success", REJECTED: "neutral", NO_CHANGE_NEEDED: "neutral", OBSOLETE: "neutral", FAILED: "danger", COMPLETED: "success", RUNNING: "info", CANCELLED: "neutral" };
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();

interface Integration {
  operations: { checks: { id: string; label: string; status: string; detail: string; evidence: string }[]; summary: Record<string, number> };
  graph: null | { sha: string; createdAt: string; nodes: { id: string; kind: string; label: string }[]; edges: { from: string; to: string; kind: string; basis: string; source: string; broken?: boolean }[]; limitations: string[]; stats: Record<string, number> };
  findings: { kind: string; severity: string; confidence: string; detail: string; files: string[]; suggestion?: string }[];
  causes: { origin: string; category: string; rootCause: string; infrastructure: boolean; status: string; investigations: string[]; symptoms: number }[];
  investigations: { id: string; buildId: string; itemKey: string; attempt: number; rootCause: string; category: string; ambiguous: boolean; infrastructure: boolean; status: string; symptoms: { id: string; detail: string }[]; hypotheses: { id: string; category: string; statement: string; score: number; explains: string[]; fix: { kind: string; change: string } }[]; requirements: string[]; createdAt: string }[];
  selections: { buildId: string; itemKey: string; status: string; changed: string[]; selection: { selected?: string[]; confidence?: string; why?: string[]; impact?: { routes: string[]; journeys: string[]; requirements: string[] } }; browser: string | null; createdAt: string }[];
}

export function IntegrationTab({ base, openRun }: { base: string; openRun: (id: string) => void }) {
  const { data, error } = useQuery<Integration>(`${base}/integration`, 20000);
  const [kind, setKind] = useState("route");
  if (error) return <p className="text-sm text-danger">Integration view unavailable: {error}</p>;
  if (!data) return <Skeleton className="h-60" />;
  const g = data.graph;
  const nodes = g?.nodes.filter((n) => n.kind === kind) ?? [];
  return (
    <div className="space-y-5" data-testid="integration">
      <section>
        <div className="metric-label mb-1">Root causes ({data.causes.length})</div>
        {data.causes.length ? <ul className="space-y-1.5">{data.causes.map((c, i) => (
          <li key={i} className="rounded-md border border-border p-2.5 text-sm"><div className="flex flex-wrap items-center gap-2"><Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{label(c.status)}</Badge><Badge tone="neutral">{label(c.category)}</Badge>{c.infrastructure && <Badge tone="warning">infrastructure — no code fix</Badge>}<span className="mono text-2xs text-text-faint">{c.origin}</span></div><p className="mt-1">{c.rootCause}</p><p className="text-2xs text-text-faint">{c.symptoms} symptom(s) across {c.investigations.length} investigation(s)</p></li>
        ))}</ul> : <p className="text-xs text-text-muted">No failed attempt has been investigated for this product.</p>}
      </section>
      {data.investigations.length > 0 && (
        <details className="text-xs"><summary className="cursor-pointer text-text-muted">Investigations ({data.investigations.length}) — symptoms and competing hypotheses</summary>
          <ul className="mt-2 space-y-2">{data.investigations.map((i) => (
            <li key={i.id} className="rounded border border-border-subtle p-2"><div className="flex flex-wrap items-center gap-2"><button className="mono underline" onClick={() => openRun(i.buildId)}>{i.itemKey} attempt {i.attempt}</button><Badge tone={STATUS_TONE[i.status] ?? "neutral"}>{label(i.status)}</Badge>{i.ambiguous && <Badge tone="warning">ambiguous</Badge>}{i.requirements.length > 0 && <span className="text-text-faint">requirements {i.requirements.join(", ")}</span>}</div>
              <p className="mt-1 text-text-muted">Symptoms: {i.symptoms.map((s) => `${s.id} ${s.detail}`).join(" · ").slice(0, 400)}</p>
              <ol className="mt-1 list-decimal pl-5">{i.hypotheses.slice(0, 3).map((h) => <li key={h.id}><span className="font-medium">{label(h.category)}</span> (score {h.score}, explains {h.explains.join(", ") || "—"}): {h.statement} <span className="text-text-faint">→ {h.fix.change}</span></li>)}</ol>
            </li>
          ))}</ul>
        </details>
      )}
      <section data-testid="operations">
        <div className="metric-label mb-1">Operational readiness <span className="text-text-faint">({Object.entries(data.operations.summary).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(" · ")})</span></div>
        <ul className="grid gap-1 text-xs sm:grid-cols-2">{data.operations.checks.map((c) => <li key={c.id} className="flex gap-2"><Badge tone={c.status === "passed" ? "success" : c.status === "failed" ? "danger" : c.status === "warning" ? "warning" : "neutral"}>{c.status.replace("_", " ")}</Badge><span><span className="font-medium">{c.label}</span> <span className="text-text-muted">— {c.detail}</span> <span className="text-text-faint">[{c.evidence}]</span></span></li>)}</ul>
      </section>
      <section>
        <div className="metric-label mb-1">Integration contracts</div>
        {data.findings.length ? <ul className="space-y-1 text-sm">{data.findings.map((f, i) => <li key={i}><Badge tone={f.confidence === "confirmed" ? "danger" : "warning"}>{label(f.kind)}</Badge> {f.detail}{f.suggestion ? <span className="text-text-muted"> — {f.suggestion}</span> : null}</li>)}</ul> : <p className="text-xs text-text-muted">{g ? "Every frontend call has a matching server route and method in the latest analysed snapshot." : "No dependency graph yet (built after the first verified run)."}</p>}
      </section>
      {g && (
        <section data-testid="dependency-graph">
          <div className="metric-label mb-1">Dependency graph @ {g.sha.slice(0, 8)} <span className="text-text-faint">({timeAgo(g.createdAt)})</span></div>
          <div className="mb-2 flex flex-wrap gap-1.5">{Object.entries(g.stats).filter(([, n]) => n > 0).map(([k, n]) => <button key={k} onClick={() => setKind(k)} data-active={kind === k} className={cn("rounded-full border px-2 py-0.5 text-2xs", kind === k ? "border-brand/50 text-text" : "border-border text-text-muted")}>{k} {n}</button>)}</div>
          <ul className="max-h-72 space-y-1 overflow-y-auto text-xs">{nodes.map((n) => {
            const out = g.edges.filter((e) => e.from === n.id || e.to === n.id);
            return <li key={n.id} className="rounded border border-border-subtle px-2 py-1"><span className="mono">{n.label}</span><span className="ml-2 text-text-faint">{out.slice(0, 6).map((e) => `${e.from === n.id ? "→" : "←"} ${e.kind} ${(e.from === n.id ? e.to : e.from).replace(/^\w+:/, "")} [${e.basis}]${e.broken ? " BROKEN" : ""}`).join(" · ")}</span></li>;
          })}</ul>
          {g.limitations.length > 0 && <p className="mt-1 text-2xs text-text-faint">Limits: {g.limitations.join(" ")}</p>}
        </section>
      )}
      <section>
        <div className="metric-label mb-1">Regression test selection (recent runs)</div>
        {data.selections.length ? <ul className="space-y-1 text-xs">{data.selections.filter((s) => s.selection.confidence).map((s) => <li key={s.buildId}><button className="mono underline" onClick={() => openRun(s.buildId)}>{s.itemKey}</button> <Badge tone="neutral">{s.status.toLowerCase()}</Badge> changed {s.changed.length} → targeted {s.selection.selected?.length ?? 0} test file(s), confidence {s.selection.confidence}; {s.selection.why?.join("; ")}{s.selection.impact?.journeys?.length ? ` · journeys: ${s.selection.impact.journeys.join(", ")}` : ""}</li>)}</ul> : <p className="text-xs text-text-muted">No runs yet.</p>}
      </section>
    </div>
  );
}

interface Evolution {
  state: { phase: string; latest: { branch: string; sha: string | null } | null; verified: { version: number; branch?: string; sha?: string } | null; deployed: { env: string; sha: string; url: string | null }[]; rolledBack: { sha: string; env: string }[]; openItems: number; openProposals: number; capabilities: { key: string; title: string }[]; note: string | null };
  role: string; mode: string; budget: Record<string, number>;
  proposals: { id: string; source: string; title: string; problem: string; evidence: { kind: string; ref: string; detail: string }[]; benefit: string; effort: string; uncertainty: string; risk: string; mandatory: boolean; approval: string; priority: number; priorityWhy: string[]; status: string; itemKey: string | null; attempts: number; outcome: { result?: string; objectiveMet?: boolean | null; note?: string }; updatedAt: string }[];
  cycles: { id: string; mode: string; status: string; summary: string; createdAt: string; checkpoint: { step?: string } }[];
}

const MODES = [["OBSERVE", "Observe — analyse only"], ["RECOMMEND", "Recommend — propose, wait for approval"], ["IMPLEMENT_ISOLATED", "Implement in isolation — run approved work on branches"], ["AUTONOMOUS", "Autonomous maintenance — also low-risk eligible work"]] as const;

export function EvolutionTab({ base, canAct, isAdmin }: { base: string; canAct: boolean; isAdmin: boolean }) {
  const { data, refetch } = useQuery<Evolution>(`${base}/evolution`, 15000);
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("open");
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState("");
  async function act(k: string, url: string, body: unknown, done: string) {
    setBusy(k);
    try {
      await fetchJSON(url, { method: "POST", body: JSON.stringify(body) });
      toast({ title: done, level: "success" });
      refetch();
    } catch (e) {
      toast({ title: "Not done", description: (e as Error).message, level: "danger" });
    }
    setBusy(null);
  }
  if (!data) return <Skeleton className="h-60" />;
  const s = data.state;
  const shown = data.proposals.filter((p) => filter === "all" || (filter === "open" ? ["OPEN", "APPROVED", "IN_PROGRESS"].includes(p.status) : !["OPEN", "APPROVED", "IN_PROGRESS"].includes(p.status)));
  return (
    <div className="space-y-5" data-testid="evolution">
      <section className="grid gap-2 sm:grid-cols-3">
        <Box title="Workspace code" body={s.latest?.sha ? `${s.latest.branch} @ ${s.latest.sha.slice(0, 8)}` : "—"} hint="latest code; may include unverified changes" />
        <Box title="Verified" body={s.verified ? `release candidate v${s.verified.version} @ ${s.verified.sha?.slice(0, 8)}` : "no verified release candidate"} hint="passed the integrated test run" />
        <Box title="Deployed" body={s.deployed.length ? s.deployed.map((d) => `${d.env} @ ${d.sha.slice(0, 8)}`).join(", ") : "not deployed"} hint={s.note ?? (s.rolledBack.length ? `${s.rolledBack.length} rollback(s) recorded` : "from verified deployment records")} />
      </section>
      <section className="rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">Maintenance policy</span>
          {isAdmin ? <select aria-label="Maintenance mode" className="input h-7 w-auto" value={data.mode} onChange={(e) => act("mode", `${base}/evolution/policy`, { mode: e.target.value }, "Policy updated")}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select> : <Badge tone="neutral">{label(data.mode)}</Badge>}
          <span className="text-2xs text-text-faint">budget: {data.budget.maxChangesPerCycle ?? 2} change(s)/cycle · {data.budget.maxAttemptsPerIssue ?? 2} attempt(s)/issue · {data.budget.maxUnreviewed ?? 3} unreviewed max</span>
          {canAct && <span className="ml-auto flex gap-2"><button disabled={!!busy} onClick={() => act("analyze", `${base}/evolution`, { action: "analyze" }, "Analysis updated")} className="btn-secondary btn-sm">{busy === "analyze" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Analyse now</button><button disabled={!!busy} onClick={() => act("cycle", `${base}/evolution/cycles`, { action: "start" }, "Maintenance cycle queued")} className="btn-primary btn-sm" data-testid="run-cycle"><Play className="h-3 w-3" /> Run maintenance cycle</button></span>}
        </div>
        <p className="mt-1 text-2xs text-text-muted">Authentication, secrets, migrations, architecture and production changes always wait for an approval, whatever the mode. Nothing is released automatically.</p>
      </section>
      <section>
        <div className="mb-2 flex items-center gap-2"><span className="metric-label">Proposals</span>{["open", "closed", "all"].map((f) => <button key={f} onClick={() => setFilter(f)} data-active={filter === f} className={cn("rounded-full border px-2 py-0.5 text-2xs capitalize", filter === f ? "border-brand/50 text-text" : "border-border text-text-muted")}>{f}</button>)}</div>
        {shown.length ? <ul className="space-y-2" data-testid="proposals">{shown.map((p) => (
          <li key={p.id} className="rounded-lg border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><Badge tone={STATUS_TONE[p.status] ?? "neutral"}>{label(p.status)}</Badge>{p.mandatory && <Badge tone="danger">mandatory</Badge>}<Badge tone="neutral">{p.source}</Badge><span className="font-medium">{p.title}</span><span className="ml-auto mono text-2xs text-text-faint">priority {Math.round(p.priority)}</span></div>
            <p className="mt-1 text-text-muted">{p.problem}</p>
            <p className="text-2xs text-text-faint">benefit {p.benefit} · effort {p.effort} · uncertainty {p.uncertainty} · regression risk {p.risk} · {p.approval === "required" ? "needs approval" : "eligible for autonomous maintenance"}{p.itemKey ? ` · task ${p.itemKey}` : ""}{p.attempts ? ` · ${p.attempts} attempt(s)` : ""}</p>
            <details className="text-2xs text-text-muted"><summary className="cursor-pointer">Why this priority · evidence ({p.evidence.length})</summary><p>{p.priorityWhy.join("; ")}</p><ul>{p.evidence.map((e, i) => <li key={i}>{e.kind} {e.ref}: {e.detail}</li>)}</ul></details>
            {p.outcome.result && <p className="text-2xs">Outcome: {p.outcome.result.replace(/_/g, " ")} — objective {p.outcome.objectiveMet === true ? "met" : p.outcome.objectiveMet === false ? "not met" : "unknown yet"}{p.outcome.note ? ` (${p.outcome.note})` : ""}</p>}
            {canAct && ["OPEN", "APPROVED"].includes(p.status) && <div className="mt-2 flex gap-2">{p.status === "OPEN" && <button disabled={!!busy} onClick={() => act(p.id, `${base}/evolution/proposals/${p.id}`, { decision: "approve" }, "Approved")} className="btn-secondary btn-sm">Approve</button>}<button disabled={!!busy} onClick={() => act(p.id, `${base}/evolution/proposals/${p.id}`, { decision: "no_change" }, "Marked: no change needed")} className="btn-ghost btn-sm">No change needed</button><button disabled={!!busy} onClick={() => act(p.id, `${base}/evolution/proposals/${p.id}`, { decision: "reject" }, "Rejected")} className="btn-ghost btn-sm">Reject</button></div>}
          </li>
        ))}</ul> : <p className="text-xs text-text-muted">{filter === "open" ? "No open proposals. Run an analysis — AURA may conclude no change is needed." : "Nothing here."}</p>}
      </section>
      {canAct && (
        <form className="flex flex-wrap gap-2 rounded-lg border border-border p-3" onSubmit={(e) => { e.preventDefault(); void act("req", `${base}/evolution`, { action: "request", title, problem }, "Request added").then(() => { setTitle(""); setProblem(""); }); }}>
          <input aria-label="Improvement title" className="input h-8 w-64" placeholder="What should improve?" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} />
          <input aria-label="Why" className="input h-8 flex-1" placeholder="Why (the problem it solves)" value={problem} onChange={(e) => setProblem(e.target.value)} required minLength={3} />
          <button className="btn-secondary btn-sm" disabled={!!busy}>Add request</button>
        </form>
      )}
      <section>
        <div className="metric-label mb-1">Maintenance cycles</div>
        {data.cycles.length ? <ul className="space-y-1 text-xs">{data.cycles.map((c) => <li key={c.id}><Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{c.status.toLowerCase()}</Badge> {label(c.mode)} · {c.summary || c.checkpoint.step} <span className="text-text-faint">{timeAgo(c.createdAt)}</span>{c.status === "RUNNING" && canAct && <button className="btn-ghost btn-sm ml-2" onClick={() => act(c.id, `${base}/evolution/cycles`, { action: "cancel", cycleId: c.id }, "Cancelled")}>Cancel</button>}</li>)}</ul> : <p className="text-xs text-text-muted">No maintenance cycle has run.</p>}
      </section>
    </div>
  );
}

function Box({ title, body, hint }: { title: string; body: string; hint: string }) {
  return <div className="rounded-lg border border-border p-3"><div className="metric-label">{title}</div><div className="mono mt-1 text-sm">{body}</div><div className="text-2xs text-text-faint">{hint}</div></div>;
}

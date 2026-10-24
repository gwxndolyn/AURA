"use client";

/**
 * Engineering intelligence: what AURA learned from this workspace's real runs
 * (/api/companies/[id]/learning). Actionable insights first; memory, failures,
 * recipes, agents, optimization and feedback on demand. Every value is a
 * persisted record; empty means nothing has been recorded yet.
 */
import { use, useState } from "react";
import Link from "next/link";
import { Search, Trash2, Power, Lightbulb } from "lucide-react";
import { useQuery, fetchJSON } from "@/hooks/useApi";
import { PageHeader, Skeleton, Badge, ErrorState, EmptyState } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { cn, timeAgo } from "@/lib/utils";

type M = { value: number | null; numerator: number; denominator: number; formula: string; unavailable?: string };
interface Data {
  promptLibrary: string; pendingEvents: number;
  insights: { severity: string; title: string; detail: string; evidence: { kind: string; id: string }[] }[];
  summary: { runs: number; byOutcome: Record<string, number>; verifiedRate: M; firstPassSuccess: M; testsExecuted: { passed: number; run: number; note: string }; reworkRate: M };
  failures: { id: string; product: string; productId: string; buildId: string; itemKey: string; attempt: number; category: string; scope: string; agentKey: string | null; rootCause: string; symptoms: string[]; evidence: { kind: string; ref: string; detail: string }[]; confidence: string; status: string; correctiveAction: string; verification: string; createdAt: string }[];
  memory: { id: string; product: string; productId: string; key: string; kind: string; content: string; status: string; staleReason: string; provenance: { type?: string; ref?: string; detail?: string }; uses: number; updatedAt: string }[];
  decisions: { id: string; key: string; content: string; status: string }[];
  knownIssues: { id: string; key: string; content: string; status: string }[];
  recipes: { id: string; key: string; title: string; version: number; status: string; scope: string; inThisWorkspace: { verified: number; failed: number; excluded: number; pending: number }; overall: { verified: number; total: number; products: number } | null }[];
  agents: { agent: string; taskKind: string; promptRef: string; runs: number; excluded: { count: number; reasons: string[] }; metrics: Record<string, M>; costUsd: number }[];
  runs: { buildId: string; product: string; productId: string; itemKey: string; kind: string; agent: string; outcome: string; attempts: number; firstPass: boolean; tests: string; criteria: string; browser: string; rework: boolean; recipes: string[]; promptRefs: string[]; finishedAt: string | null }[];
  feedback: { id: string; text: string; kind: string; scope: string; status: string; product: string | null; actions: { type: string; detail: string }[]; appliedCount: number; lastAppliedAt: string | null; createdAt: string }[];
  optimization: { promotions: { id: string; action: string; reason: string; approvedBy: string; createdAt: string }[]; promptExperiments: { id: string; status: string; recommendation: string | null; summary: string; mode: string | null; createdAt: string }[]; methodExperiments: { id: string; key: string; title: string; status: string; reasons: string[]; createdAt: string }[] };
}
interface Problems { problems: { agentKey: string; category: string; failures: number; runs: number; fixAvailable: boolean; evidence: { buildId: string; itemKey: string; rootCause: string }[] }[] }

const TABS = ["insights", "failures", "memory", "recipes", "agents", "optimization", "feedback"] as const;
const TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = { VERIFIED: "success", FAILED: "danger", BLOCKED: "warning", INFRA_FAILED: "neutral", BUDGET_STOPPED: "neutral", CANCELLED: "neutral", ESTABLISHED: "info", HYPOTHESIS: "warning", UNKNOWN: "neutral", VALIDATED: "success", UNVALIDATED: "neutral", PROPOSED: "neutral", ASSUMPTION: "warning", STALE: "neutral", INVALIDATED: "danger", PENDING: "neutral", NOT_APPLICABLE: "neutral" };
const pct = (m: M) => (m.value == null ? <span className="text-text-faint">unavailable — {m.unavailable}</span> : <span title={m.formula}>{Math.round(m.value * 100)}% <span className="text-text-faint">({m.numerator}/{m.denominator})</span></span>);
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();

export default function Learning({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tab, setTab] = useState<(typeof TABS)[number]>("insights");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const base = `/api/companies/${id}/learning`;
  const { data, error, refetch } = useQuery<Data>(`${base}${query ? `?q=${encodeURIComponent(query)}` : ""}`, 30000);
  const run = (b: string, p: string) => `/app/${id}/products/${p}?tab=runs&run=${b}`;
  if (error) return <div className="page"><ErrorState message={`Engineering intelligence is unavailable: ${error}`} onRetry={refetch} /></div>;
  if (!data) return <div className="page"><Skeleton className="h-80" /></div>;
  const s = data.summary;
  return (
    <div className="page space-y-5" data-testid="learning">
      <PageHeader title="Engineering intelligence" description="What AURA has learned from your real runs: verified facts, failures and their causes, recipes, and how its agents perform. Every entry links to the run it came from." />
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Runs recorded" value={String(s.runs)} hint={Object.entries(s.byOutcome).map(([k, v]) => `${v} ${label(k)}`).join(" · ") || "none yet"} />
        <Stat label="Verified" value={pct(s.verifiedRate)} hint="infra/budget/cancelled excluded" />
        <Stat label="First-pass success" value={pct(s.firstPassSuccess)} hint="no repair needed" />
        <Stat label="Tests executed" value={`${s.testsExecuted.passed}/${s.testsExecuted.run} passed`} hint={s.testsExecuted.note} />
      </div>
      {data.pendingEvents > 0 && <p className="text-xs text-text-muted">{data.pendingEvents} outcome(s) are still being processed in the background; numbers update shortly.</p>}
      <div className="tabs" role="tablist">{TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} data-active={tab === t} onClick={() => setTab(t)} className="tab capitalize">{t}</button>)}</div>

      {tab === "insights" && (data.insights.length ? (
        <ul className="space-y-2" data-testid="insights">{data.insights.map((i, n) => (
          <li key={n} className="rounded-lg border border-border p-3"><div className="flex items-center gap-2"><Badge tone={i.severity === "high" ? "danger" : i.severity === "medium" ? "warning" : "neutral"}>{i.severity}</Badge><span className="font-medium">{i.title}</span></div><p className="mt-1 text-sm text-text-muted">{i.detail}</p>{i.evidence.length > 0 && <p className="mt-1 text-2xs text-text-faint">evidence: {i.evidence.map((e) => { const r = data.runs.find((x) => x.buildId === e.id) ?? data.failures.find((x) => x.buildId === e.id); return r ? <Link key={e.id} href={run(e.id, r.productId)} className="mr-2 underline">run {e.id.slice(-6)}</Link> : <span key={e.id} className="mono mr-2">{e.id.slice(-6)}</span>; })}</p>}</li>
        ))}</ul>
      ) : <EmptyState icon={Lightbulb} title="No insights yet" description="Insights appear once runs have finished: recurring failure causes, fixes that did not work, and environment problems." />)}

      {tab === "failures" && (data.failures.length ? (
        <ul className="space-y-2" data-testid="failures">{data.failures.map((f) => (
          <li key={f.id} className="rounded-lg border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="mono text-xs text-text-faint">{f.product} · {f.itemKey} · attempt {f.attempt}</span><Badge tone="neutral">{label(f.category)}</Badge><Badge tone={TONE[f.status]}>{f.status.toLowerCase()}</Badge><span className="text-2xs text-text-faint">{f.confidence} confidence · {f.scope}{f.agentKey ? ` (${f.agentKey})` : ""}</span><span className="ml-auto text-2xs text-text-faint">{timeAgo(f.createdAt)}</span></div>
            <p className="mt-1">{f.rootCause}</p>
            {f.symptoms.length > 0 && <p className="text-xs text-text-muted">Symptoms: {f.symptoms.join("; ")}</p>}
            <p className="text-xs text-text-muted">Next: {f.correctiveAction} — <Badge tone={f.verification === "VERIFIED" ? "success" : f.verification === "FAILED" ? "danger" : "neutral"}>{label(f.verification)}</Badge></p>
            <details className="mt-1 text-2xs text-text-faint"><summary className="cursor-pointer">Evidence ({f.evidence.length})</summary><ul>{f.evidence.map((e, i) => <li key={i}>{e.kind} {e.ref.slice(-8)}: {e.detail}</li>)}</ul><Link href={run(f.buildId, f.productId)} className="underline">open run</Link></details>
          </li>
        ))}</ul>
      ) : <EmptyState icon={Lightbulb} title="No failures recorded" description="When an attempt fails, AURA records its root cause here with the evidence — or 'unknown' if the evidence does not support one." />)}

      {tab === "memory" && (
        <div className="space-y-3">
          <form onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }} className="flex gap-2"><div className="relative flex-1"><Search className="absolute left-2 top-2 h-3.5 w-3.5 text-text-faint" /><input aria-label="Search memory" className="input h-8 pl-7" placeholder="Search facts, decisions, known issues" value={q} onChange={(e) => setQ(e.target.value)} /></div><button className="btn-secondary btn-sm">Search</button></form>
          {data.decisions.length > 0 && <Section title="Decisions and contracts">{data.decisions.map((d) => <Row key={d.id} status={d.status} text={d.content} sub={d.key} />)}</Section>}
          {data.knownIssues.length > 0 && <Section title="Known issues and failed approaches">{data.knownIssues.map((d) => <Row key={d.id} status={d.status} text={d.content} sub={d.key} />)}</Section>}
          {data.memory.length ? <Section title={`Project memory (${data.memory.length})`}>{data.memory.map((m) => <Row key={m.id} status={m.status} text={m.content} sub={`${m.product} · ${m.kind} · from ${m.provenance.type ?? "?"} ${m.provenance.ref?.slice(-6) ?? ""} · used ${m.uses}× · ${timeAgo(m.updatedAt)}${m.staleReason ? ` · ${m.staleReason}` : ""}`} />)}</Section> : <EmptyState icon={Lightbulb} title={query ? "No matching memory" : "No project memory yet"} description="Memory is written only from verified runs and approvals (facts), or labelled as an assumption." />}
        </div>
      )}

      {tab === "recipes" && (data.recipes.length ? (
        <Section title="Recipes used in this workspace">{data.recipes.map((r) => <div key={r.id} className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-3 py-2 text-sm first:border-t-0"><span className="font-medium">{r.title}</span><span className="mono text-2xs text-text-faint">{r.key}@v{r.version} · {r.scope}</span><Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge><span className="ml-auto text-xs text-text-muted">here: {r.inThisWorkspace.verified} verified · {r.inThisWorkspace.failed} failed{r.inThisWorkspace.excluded ? ` · ${r.inThisWorkspace.excluded} excluded (infra)` : ""}{r.inThisWorkspace.pending ? ` · ${r.inThisWorkspace.pending} running` : ""}</span></div>)}</Section>
      ) : <EmptyState icon={Lightbulb} title="No recipes applied yet" description="Recipes are offered to agents only when they fit the task (stack, kind, keywords). They start as unvalidated guidance and become validated after verified uses on several products." />)}

      {tab === "agents" && (data.agents.length ? (
        <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-xs" data-testid="agent-performance"><thead className="text-text-faint"><tr><th className="p-2">Agent · task · prompt</th><th className="p-2">Runs</th><th className="p-2">Verified</th><th className="p-2">First pass</th><th className="p-2">Criteria met</th><th className="p-2">Attempts / verified</th><th className="p-2">Rework</th></tr></thead>
          <tbody>{data.agents.map((a) => <tr key={`${a.agent}${a.taskKind}${a.promptRef}`} className="border-t border-border-subtle"><td className="p-2"><span className="font-medium">{a.agent}</span> · {a.taskKind.toLowerCase()}<div className="mono text-2xs text-text-faint">{a.promptRef}</div></td><td className="p-2">{a.runs}{a.excluded.count ? <div className="text-2xs text-text-faint">{a.excluded.count} excluded ({a.excluded.reasons.map(label).join(", ")})</div> : null}</td><td className="p-2">{pct(a.metrics.verifiedRate)}</td><td className="p-2">{pct(a.metrics.firstPassSuccess)}</td><td className="p-2">{pct(a.metrics.criteriaMet)}</td><td className="p-2">{a.metrics.attemptsPerVerified.value == null ? "—" : a.metrics.attemptsPerVerified.value.toFixed(1)}</td><td className="p-2">{pct(a.metrics.reworkRate)}</td></tr>)}</tbody></table></div>
      ) : <EmptyState icon={Lightbulb} title="No agent outcomes yet" description="Each finished engineering run records its owner agent, prompt version, tests and outcome here." />)}

      {tab === "optimization" && <Optimization id={id} data={data} />}
      {tab === "feedback" && <Feedback id={id} data={data} refetch={refetch} />}
    </div>
  );
}

function Optimization({ id, data }: { id: string; data: Data }) {
  const { data: p, refetch } = useQuery<Problems>(`/api/companies/${id}/learning/optimize`);
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  async function act(body: object, k: string, done: string) {
    setBusy(k);
    try {
      const r = await fetchJSON<{ id?: string; note?: string | null }>(`/api/companies/${id}/learning/optimize`, { method: "POST", body: JSON.stringify(body) });
      toast({ title: done, description: r.note ?? undefined, level: "success" });
      refetch();
    } catch (e) {
      toast({ title: "Not done", description: (e as Error).message, level: "danger" });
    }
    setBusy(null);
  }
  return (
    <div className="space-y-4">
      <Section title="Evidence-backed problems">{!p ? <Skeleton className="h-16" /> : p.problems.length ? p.problems.map((x) => <div key={`${x.agentKey}${x.category}`} className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-3 py-2 text-sm first:border-t-0"><span className="font-medium">{x.agentKey}</span><Badge tone="warning">{label(x.category)}</Badge><span className="text-xs text-text-muted">{x.failures} failing run(s) of {x.runs}</span>{x.fixAvailable && <button disabled={!!busy} onClick={() => act({ action: "propose", agentKey: x.agentKey, category: x.category }, x.category, "Draft prompt version created — evaluate it before promoting")} className="btn-secondary btn-sm ml-auto">Draft a bounded prompt change</button>}</div>) : <p className="px-3 py-2 text-xs text-text-muted">No recurring agent-caused failure across at least two runs. One-off failures are not treated as patterns.</p>}</Section>
      <Section title="Prompt experiments">{data.optimization.promptExperiments.length ? data.optimization.promptExperiments.map((e) => <div key={e.id} className="border-t border-border-subtle px-3 py-2 text-xs first:border-t-0"><Badge tone={e.recommendation === "promote" ? "success" : e.recommendation === "block" ? "danger" : "neutral"}>{e.recommendation ?? e.status.toLowerCase()}</Badge> {e.mode === "simulation" && <Badge tone="warning">simulated — not evidence</Badge>} <span className="text-text-muted">{e.summary}</span> <span className="text-text-faint">{timeAgo(e.createdAt)}</span></div>) : <p className="px-3 py-2 text-xs text-text-muted">No prompt experiments yet.</p>}</Section>
      <Section title="Promotions and rollbacks">{data.optimization.promotions.length ? data.optimization.promotions.map((x) => <div key={x.id} className="border-t border-border-subtle px-3 py-2 text-xs first:border-t-0"><Badge tone={x.action === "PROMOTE" ? "success" : x.action === "ROLLBACK" ? "warning" : "danger"}>{x.action.toLowerCase()}</Badge> <span className="text-text-muted">{x.reason}</span> <span className="text-text-faint">by {x.approvedBy} · {timeAgo(x.createdAt)}</span></div>) : <p className="px-3 py-2 text-xs text-text-muted">No prompt has been promoted or rolled back. Production prompts are library version {data.promptLibrary}.</p>}</Section>
      <Section title="Engineering-method experiments (lab)">{data.optimization.methodExperiments.length ? data.optimization.methodExperiments.map((e) => <div key={e.id} className="border-t border-border-subtle px-3 py-2 text-xs first:border-t-0"><Badge tone={TONE[e.status] ?? "neutral"}>{e.status.toLowerCase()}</Badge> <span className="font-medium">{e.title}</span> <span className="text-text-muted">{e.reasons.join("; ")}</span></div>) : <p className="px-3 py-2 text-xs text-text-muted">No lab experiments in this workspace.</p>}</Section>
    </div>
  );
}

function Feedback({ id, data, refetch }: { id: string; data: Data; refetch: () => void }) {
  const { toast } = useApp();
  async function act(url: string, init: RequestInit, done: string) {
    try {
      await fetchJSON(url, init);
      toast({ title: done, level: "success" });
      refetch();
    } catch (e) {
      toast({ title: "Not done", description: (e as Error).message, level: "danger" });
    }
  }
  if (!data.feedback.length) return <EmptyState icon={Lightbulb} title="No saved feedback" description="Corrections you give on a product (for example 'the mobile layout is broken') become concrete criteria and instructions for that product's next runs. Add them from a product's run view." />;
  return (
    <Section title="Your corrections and preferences">{data.feedback.map((f) => (
      <div key={f.id} className={cn("border-t border-border-subtle px-3 py-2 text-sm first:border-t-0", f.status === "DISABLED" && "opacity-60")} data-testid="feedback-item">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">“{f.text}”</span><Badge tone="neutral">{label(f.kind)}</Badge><Badge tone="info">{f.scope === "workspace" ? "all products" : f.product ?? "product"}</Badge>{f.status === "DISABLED" && <Badge tone="neutral">disabled</Badge>}
          <span className="ml-auto flex gap-1"><button aria-label={f.status === "ACTIVE" ? "Disable" : "Enable"} className="btn-ghost btn-sm" onClick={() => act(`/api/companies/${id}/learning/feedback/${f.id}`, { method: "PATCH", body: JSON.stringify({ status: f.status === "ACTIVE" ? "DISABLED" : "ACTIVE" }) }, f.status === "ACTIVE" ? "Disabled" : "Enabled")}><Power className="h-3 w-3" /></button><button aria-label="Delete" className="btn-ghost btn-sm" onClick={() => confirm("Delete this saved feedback?") && act(`/api/companies/${id}/learning/feedback/${f.id}`, { method: "DELETE" }, "Deleted")}><Trash2 className="h-3 w-3" /></button></span></div>
        <ul className="mt-1 text-xs text-text-muted">{f.actions.map((a, i) => <li key={i}>→ {label(a.type)}: {a.detail}</li>)}</ul>
        <p className="text-2xs text-text-faint">Applied to {f.appliedCount} run(s){f.lastAppliedAt ? `, last ${timeAgo(f.lastAppliedAt)}` : ""}. Applying feedback is not proof it helped; see outcomes of those runs.</p>
      </div>
    ))}</Section>
  );
}

function Stat({ label: l, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return <div className="rounded-lg border border-border p-3"><div className="metric-label">{l}</div><div className="mt-1 text-sm font-medium">{value}</div>{hint && <div className="text-2xs text-text-faint">{hint}</div>}</div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-lg border border-border"><div className="border-b border-border px-3 py-2 text-xs font-medium">{title}</div><div>{children}</div></section>;
}
function Row({ status, text, sub }: { status: string; text: string; sub: string }) {
  return <div className="border-t border-border-subtle px-3 py-2 text-sm first:border-t-0"><div className="flex items-start gap-2"><Badge tone={TONE[status] ?? "neutral"}>{status.toLowerCase()}</Badge><span>{text}</span></div><div className="mono mt-0.5 text-2xs text-text-faint">{sub}</div></div>;
}

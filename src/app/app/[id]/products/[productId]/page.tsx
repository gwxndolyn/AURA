"use client";

import Link from "next/link";
import { Suspense, use, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, CircleDashed, GitBranch, Loader2, Pause, Play, Square, XCircle } from "lucide-react";
import { useQuery, fetchJSON } from "@/hooks/useApi";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { PageHeader, ErrorState, Skeleton, Badge } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { cn, timeAgo } from "@/lib/utils";
import { GateTab, DefectsTab, MemoryTab, CodeTab, ImpactView, type Impact } from "@/components/products/engineering";
import { DeliveryTab, ChangesTab } from "@/components/products/delivery";

type Ev = { kind: string; ref: string; detail: string };
interface Item { id: string; key: string; level: string; kind: string; parentKey: string | null; title: string; description: string; acceptance: string[]; dependsOn: string[]; capabilities: string[]; files: string[]; verifyBy: string[]; effort: number; risk: string; priority: number; status: string; verification: string; executable: boolean; missionId: string | null; buildId: string | null; blockedReason: string; attempts: number; evidence: Ev[]; history: { at: string; actor: string; change: string }[]; mission: { id: string; status: string; statusReason: string; repairRounds: number } | null }
interface Artifact { id: string; kind: string; version: number; title: string; content: any; status: string; source: string; producedBy: string; consumedBy: string[]; feedback: { at: string; by: string; text: string }[]; createdAt: string }
interface Approval { id: string; action: string; actionClass: string; classHelp: string; target: string; summary: string; risks: string[]; status: string; decidedBy: string | null; decidedAt: string | null; createdAt: string }
interface Detail {
  role: string;
  product: { id: string; companyId: string; title: string; idea: string; phase: string; phaseLabel: string; status: string; planningStatus: string; planningError: string; autonomy: string; autonomyHelp: string; scopeApproved: boolean; scopeApprovedBy: string | null; version: number; limits: { maxRepairs: number; maxParallel: number; budgetUsd: number; maxAttempts: number; projectBudgetUsd: number }; template: string | null };
  brief: { version: number; source: string; author: string; note: string; content: any } | null;
  briefVersions: { version: number; source: string; author: string; createdAt: string }[];
  items: Item[];
  artifacts: Artifact[];
  transitions: { id: string; fromPhase: string; toPhase: string; reason: string; actor: string; createdAt: string }[];
  approvals: Approval[];
  repo: { id: string; provider: string; name: string; defaultBranch: string; status: { configured: boolean; missing: string[] } } | null;
  gitOps: { id: string; op: string; branch: string | null; sha: string | null; url: string | null; status: string; detail: string; createdAt: string }[];
  overview: { phase: string; milestone: { id: string; name: string } | null; progress: { definition: string; verified: number; executable: number; ratio: number | null; nonExecutable: number; acceptedUnverified: number }; active: { key: string; title: string; status: string }[]; blocked: { key: string; title: string; reason: string }[]; verified: { key: string; title: string }[]; failedChecks: string[]; pendingApprovals: number; usage: { costUsd: number; modelCalls: number; toolCalls: number; note: string }; next: string };
}
interface Readiness { checks: { id: string; label: string; status: string; detail: string }[]; summary: { passed: number; failed: number; notRun: number; notApplicable: number }; canCreateCandidate: boolean; note: string }

const TABS = ["overview", "brief", "backlog", "runs", "defects", "design", "approvals", "quality", "release", "deploy", "changes", "memory", "code", "repository", "timeline"] as const;
type Tab = (typeof TABS)[number];
const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = { VERIFIED: "success", DONE_UNVERIFIED: "neutral", IN_PROGRESS: "info", IN_REVIEW: "info", READY: "neutral", TODO: "neutral", FAILED: "danger", BLOCKED: "warning", CANCELLED: "neutral" };
const VERIFY_ICON: Record<string, React.ReactNode> = { PASSED: <CheckCircle2 className="h-3.5 w-3.5 text-success" />, FAILED: <XCircle className="h-3.5 w-3.5 text-danger" />, BLOCKED: <AlertTriangle className="h-3.5 w-3.5 text-warning" />, RUNNING: <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />, INCONCLUSIVE: <CircleDashed className="h-3.5 w-3.5 text-text-faint" />, NOT_RUN: <CircleDashed className="h-3.5 w-3.5 text-text-faint" /> };
const statusText = (s: string) => (s === "DONE_UNVERIFIED" ? "accepted · unverified" : s.toLowerCase().replace(/_/g, " "));

export default function Page({ params }: { params: Promise<{ id: string; productId: string }> }) {
  return (
    <Suspense fallback={<div className="page"><Skeleton className="h-80" /></div>}>
      <ProductControlCentre params={params} />
    </Suspense>
  );
}

function ProductControlCentre({ params }: { params: Promise<{ id: string; productId: string }> }) {
  const { id, productId } = use(params);
  const base = `/api/companies/${id}/products/${productId}`;
  const router = useRouter();
  const search = useSearchParams();
  const { toast } = useApp();
  const { data: d, error, refetch } = useQuery<Detail>(base, 8000);
  const [tab, setTab] = useState<Tab>((search.get("tab") as Tab) ?? "overview");
  const [sel, setSel] = useState<string | null>(search.get("item"));
  const [run, setRun] = useState<string | null>(search.get("run"));
  const [busy, setBusy] = useState<string | null>(null);
  const { version } = useLiveEvents(id);
  useEffect(() => {
    if (version > 0) refetch();
  }, [version, refetch]);

  const go = (t: Tab) => {
    setTab(t);
    router.replace(`/app/${id}/products/${productId}?tab=${t}`, { scroll: false });
  };

  async function act(label: string, url: string, body: unknown, method = "POST", ok?: (r: any) => string) {
    setBusy(label);
    try {
      const r = await fetchJSON<any>(url, { method, body: JSON.stringify(body) });
      toast({ title: label, description: ok?.(r), level: "success" });
      await refetch();
      return r;
    } catch (e) {
      toast({ title: `${label} failed`, description: (e as Error).message, level: "danger" });
    } finally {
      setBusy(null);
    }
  }

  async function tick() {
    // Run bounded ticks until nothing progresses (each is one idempotent server step).
    setBusy("Run team");
    try {
      for (let i = 0; i < 8; i++) {
        const r = await fetchJSON<{ dispatched: string[]; advanced: string[]; settled: { key: string; status: string }[]; waitingOn: string[]; note?: string }>(`${base}/tick`, { method: "POST", body: JSON.stringify({ steps: 6 }) });
        await refetch();
        if (r.note) {
          toast({ title: "Nothing to run", description: r.note, level: "info" });
          break;
        }
        if (!r.dispatched.length && !r.advanced.length && !r.settled.length) {
          if (r.waitingOn.length) toast({ title: "Waiting", description: r.waitingOn.slice(0, 3).join(" · "), level: "info" });
          break;
        }
      }
    } catch (e) {
      toast({ title: "Run failed", description: (e as Error).message, level: "danger" });
    } finally {
      setBusy(null);
    }
  }

  if (error && !d) return <div className="page"><ErrorState message={error} onRetry={refetch} /></div>;
  if (!d) return <div className="page space-y-3"><Skeleton className="h-10 w-1/3" /><Skeleton className="h-72" /></div>;
  const p = d.product;
  const canAct = d.role !== "VIEWER";
  const pending = d.approvals.filter((a) => a.status === "PENDING");

  return (
    <div className="page" data-testid="product">
      <PageHeader
        title={p.title}
        description={<span className="line-clamp-2">{p.idea}</span>}
        meta={<><Badge tone="info" >{p.phaseLabel}</Badge>{p.status !== "ACTIVE" && <Badge tone="warning">{p.status.toLowerCase()}</Badge>}<Badge>autonomy: {p.autonomy.toLowerCase()}</Badge></>}
        actions={canAct && p.status !== "CANCELLED" ? (
          <>
            <button onClick={tick} disabled={!!busy || p.status !== "ACTIVE" || !p.scopeApproved} className="btn-primary btn-sm" data-testid="run-team" title={!p.scopeApproved ? "Approve the scope first" : "Dispatch ready work and advance running tasks"}>{busy === "Run team" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run team</button>
            {p.status === "ACTIVE" ? <button onClick={() => act("Paused", `${base}/control`, { action: "pause" })} disabled={!!busy} className="btn-secondary btn-sm"><Pause className="h-3 w-3" /> Pause</button> : <button onClick={() => act("Resumed", `${base}/control`, { action: "resume" })} disabled={!!busy} className="btn-secondary btn-sm"><Play className="h-3 w-3" /> Resume</button>}
            <button onClick={() => window.confirm("Cancel this product? Running missions are cancelled; verified history is kept.") && act("Cancelled", `${base}/control`, { action: "cancel" }, "POST", (r) => (r.notes?.length ? `Could not stop immediately: ${r.notes.join("; ")}` : "All work stopped"))} disabled={!!busy} className="btn-ghost btn-sm"><Square className="h-3 w-3" /> Cancel</button>
          </>
        ) : undefined}
      />

      {p.planningStatus !== "READY" && (
        <div className={cn("mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm", p.planningStatus === "FAILED" ? "border-danger/40 bg-danger/5" : "border-info/40 bg-info/5")} role="status" data-testid="planning-status">
          {p.planningStatus === "FAILED" ? <XCircle className="h-4 w-4 text-danger" /> : <Loader2 className="h-4 w-4 animate-spin text-info" />}
          <span>{p.planningStatus === "FAILED" ? `Planning failed: ${p.planningError}` : "The product manager is drafting the brief and backlog…"}</span>
          {p.planningStatus === "FAILED" && canAct && <button onClick={() => act("Planning restarted", `${base}/plan`, {})} className="btn-secondary btn-sm ml-auto">Retry planning</button>}
        </div>
      )}
      {pending.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm" role="status">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <span>{pending.length === 1 ? "1 decision needs you" : `${pending.length} decisions need you`}: {pending.map((a) => a.summary).join(" · ")}</span>
          <button onClick={() => go("approvals")} className="btn-secondary btn-sm ml-auto">Review</button>
        </div>
      )}

      <div className="tabs mb-4 overflow-x-auto" role="tablist">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} data-active={tab === t} onClick={() => go(t)} className="tab capitalize">{t}{t === "approvals" && pending.length ? ` (${pending.length})` : ""}</button>)}
      </div>

      {tab === "overview" && <Overview d={d} onOpen={(k) => { setSel(k); go("backlog"); }} />}
      {tab === "brief" && <BriefTab d={d} base={base} canAct={canAct} onSaved={refetch} />}
      {tab === "backlog" && <Backlog d={d} sel={sel} setSel={setSel} companyId={id} base={base} canAct={canAct} act={act} openRun={(r) => { setRun(r); go("runs"); }} />}
      {tab === "runs" && <RunsTab companyId={id} productId={productId} run={run} setRun={setRun} canAct={canAct} version={version} />}
      {tab === "defects" && <DefectsTab base={base} version={version} openRun={(r) => { setRun(r); go("runs"); }} />}
      {tab === "quality" && <GateTab base={base} canAct={canAct} isAdmin={["OWNER", "ADMIN"].includes(d.role)} version={version} />}
      {tab === "deploy" && <DeliveryTab base={base} canAct={canAct} isAdmin={["OWNER", "ADMIN"].includes(d.role)} version={version} />}
      {tab === "changes" && <ChangesTab base={base} canAct={canAct} version={version} />}
      {tab === "memory" && <MemoryTab base={base} canAct={canAct} isAdmin={["OWNER", "ADMIN"].includes(d.role)} version={version} />}
      {tab === "code" && <CodeTab base={base} item={sel} />}
      {tab === "design" && <DesignTab d={d} base={base} canAct={canAct} act={act} />}
      {tab === "approvals" && <Approvals d={d} base={base} canAct={canAct} act={act} />}
      {tab === "release" && <ReleaseTab base={base} canAct={canAct} act={act} d={d} />}
      {tab === "repository" && <RepoTab d={d} base={base} />}
      {tab === "timeline" && <TimelineTab base={base} version={version} />}
    </div>
  );
}

function Overview({ d, onOpen }: { d: Detail; onOpen: (k: string) => void }) {
  const o = d.overview;
  const pr = o.progress;
  return (
    <div className="space-y-5" data-testid="overview">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-border p-3"><div className="metric-label">Phase</div><div className="mt-1 font-medium">{d.product.phaseLabel}</div><div className="text-2xs text-text-faint">{o.milestone ? `${o.milestone.id} · ${o.milestone.name}` : "no milestone"}</div></div>
        <div className="rounded-lg border border-border p-3" title={pr.definition}><div className="metric-label">Verified work</div><div className="mono mt-1 text-lg" data-testid="progress">{pr.executable ? `${pr.verified}/${pr.executable}` : "—"}</div><div className="text-2xs text-text-faint">executable tasks verified in the sandbox{pr.nonExecutable ? ` · ${pr.nonExecutable} not executable (${pr.acceptedUnverified} accepted unverified)` : ""}</div></div>
        <div className="rounded-lg border border-border p-3"><div className="metric-label">Needs you</div><div className="mono mt-1 text-lg">{o.pendingApprovals + o.blocked.length}</div><div className="text-2xs text-text-faint">{o.pendingApprovals} approval(s) · {o.blocked.length} blocked</div></div>
        <div className="rounded-lg border border-border p-3"><div className="metric-label">Model usage</div><div className="mono mt-1 text-lg">${o.usage.costUsd.toFixed(4)}</div><div className="text-2xs text-text-faint">{o.usage.modelCalls} model · {o.usage.toolCalls} tool calls — {o.usage.note}</div></div>
      </div>
      <section className="rounded-lg border border-border p-3 text-sm"><span className="metric-label">What happens next · </span>{o.next}</section>
      <div className="grid gap-4 lg:grid-cols-3">
        <ListBox title="Team is working on" empty="Nothing running." items={o.active.map((a) => ({ key: a.key, text: a.title, note: statusText(a.status) }))} onOpen={onOpen} />
        <ListBox title="Blocked" empty="Nothing blocked." items={o.blocked.map((b) => ({ key: b.key, text: b.title, note: b.reason }))} onOpen={onOpen} tone="warning" />
        <ListBox title="Verified" empty="Nothing verified yet — verified means sandbox tests and review passed." items={o.verified.map((v) => ({ key: v.key, text: v.title }))} onOpen={onOpen} tone="success" />
      </div>
      <section>
        <h3 className="section-title mb-2">Lifecycle</h3>
        <ol className="space-y-1 text-xs" data-testid="transitions">
          {d.transitions.map((t) => <li key={t.id} className="flex gap-2"><span className="mono w-16 shrink-0 text-text-faint">{timeAgo(t.createdAt)}</span><span className="mono">{t.fromPhase} → {t.toPhase}</span><span className="text-text-muted">{t.reason}</span><span className="ml-auto text-text-faint">{t.actor}</span></li>)}
        </ol>
      </section>
    </div>
  );
}

function ListBox({ title, items, empty, onOpen, tone }: { title: string; items: { key: string; text: string; note?: string }[]; empty: string; onOpen: (k: string) => void; tone?: "warning" | "success" }) {
  return (
    <section className="rounded-lg border border-border p-3">
      <h3 className={cn("section-title mb-2", tone === "warning" && "text-warning", tone === "success" && "text-success")}>{title} ({items.length})</h3>
      {items.length === 0 ? <p className="text-xs text-text-muted">{empty}</p> : (
        <ul className="space-y-1.5 text-xs">{items.map((i) => <li key={i.key}><button onClick={() => onOpen(i.key)} className="text-left hover:underline"><span className="mono text-text-faint">{i.key}</span> {i.text}</button>{i.note && <div className="text-2xs text-text-muted">{i.note}</div>}</li>)}</ul>
      )}
    </section>
  );
}

function BriefTab({ d, base, canAct, onSaved }: { d: Detail; base: string; canAct: boolean; onSaved: () => void }) {
  const { toast } = useApp();
  const b = d.brief;
  const [text, setText] = useState(() => JSON.stringify(b?.content ?? {}, null, 2));
  const [editing, setEditing] = useState(false);
  if (!b) return <p className="text-sm text-text-muted">No brief.</p>;
  const c = b.content;
  async function save() {
    let content: unknown;
    try {
      content = JSON.parse(text);
    } catch {
      toast({ title: "Invalid JSON", level: "danger" });
      return;
    }
    try {
      const r = await fetchJSON<{ version: number; affected: string[] }>(`${base}/brief`, { method: "PUT", body: JSON.stringify({ content, expectedVersion: b!.version }) });
      toast({ title: `Brief v${r.version} saved`, description: r.affected.length ? `${r.affected.length} backlog item(s) flagged; scope needs re-approval.` : undefined, level: "success" });
      setEditing(false);
      onSaved();
    } catch (e) {
      toast({ title: "Not saved", description: (e as Error).message, level: "danger" });
    }
  }
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]" data-testid="brief">
      <div className="space-y-4 text-sm">
        <div className="flex items-center gap-2"><h2 className="font-medium">Brief v{b.version}</h2><Badge tone={b.source === "model" ? "info" : "warning"}>{b.source === "model" ? "drafted by the PM model" : b.source === "user" ? `edited by ${b.author}` : "deterministic template — no model"}</Badge>{canAct && <button onClick={() => setEditing(!editing)} className="btn-ghost btn-sm ml-auto">{editing ? "Close editor" : "Edit"}</button>}</div>
        {b.note && <p className="text-2xs text-text-faint">{b.note}</p>}
        {editing ? (
          <div><textarea value={text} onChange={(e) => setText(e.target.value)} rows={24} className="input mono w-full py-2 text-xs" aria-label="Brief JSON" /><button onClick={save} className="btn-primary btn-sm mt-2">Save as new revision</button><p className="mt-1 text-2xs text-text-faint">Validated server-side. Changing requirements flags affected backlog items and re-opens scope approval.</p></div>
        ) : (
          <>
            <p>{c.problem}</p>
            <Block title="Personas">{c.personas?.map((x: any) => <li key={x.name}><strong className="font-medium">{x.name}</strong>: {x.needs.join("; ")}</li>)}</Block>
            <Block title="Functional requirements">{c.functional?.map((x: any) => <li key={x.id}><span className="mono text-text-faint">{x.id}</span> {x.text}</li>)}</Block>
            <Block title="Non-functional">{c.nonFunctional?.map((x: any) => <li key={x.id}><span className="mono text-text-faint">{x.id}</span> {x.text}</li>)}</Block>
            <Block title="Acceptance criteria">{c.acceptance?.map((x: any) => <li key={x.id}><span className="mono text-text-faint">{x.id}</span> {x.text}{x.measurable ? "" : " (not measurable)"}</li>)}</Block>
            <div className="grid gap-4 md:grid-cols-2"><Block title="MVP">{c.mvp?.map((x: string) => <li key={x}>{x}</li>)}</Block><Block title="Out of scope">{c.outOfScope?.map((x: string) => <li key={x}>{x}</li>)}</Block></div>
            <Block title="Journeys">{c.journeys?.map((j: any) => <li key={j.name}><strong className="font-medium">{j.name}</strong>: {j.steps.join(" → ")}</li>)}</Block>
            <Block title="Assumptions (editable)">{c.assumptions?.map((x: any) => <li key={x.id}><span className="mono text-text-faint">{x.id}</span> {x.text}</li>)}</Block>
            <Block title="Open questions">{c.questions?.map((q: any) => <li key={q.text}>{q.material && <Badge tone="warning" className="mr-1">material</Badge>}{q.text} <span className="text-text-faint">Default: {q.default}</span></li>)}</Block>
            <Block title="Risks">{c.risks?.map((x: string) => <li key={x}>{x}</li>)}</Block>
            <Block title="Milestones">{c.milestones?.map((m: any) => <li key={m.id}><span className="mono text-text-faint">{m.id}</span> {m.name} — {m.goal}</li>)}</Block>
          </>
        )}
      </div>
      <aside className="text-xs"><div className="metric-label mb-1">Revisions</div><ol className="space-y-1">{d.briefVersions.map((v) => <li key={v.version}><span className="mono">v{v.version}</span> {v.source} · {v.author} · {timeAgo(v.createdAt)}</li>)}</ol></aside>
    </div>
  );
}

const Block = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section><div className="metric-label mb-1">{title}</div><ul className="list-disc space-y-0.5 pl-5 text-text-muted">{children}</ul></section>
);

function Backlog({ d, sel, setSel, companyId, base, canAct, act, openRun }: { d: Detail; sel: string | null; setSel: (k: string | null) => void; companyId: string; base: string; canAct: boolean; act: (l: string, u: string, b: unknown, m?: string) => Promise<any>; openRun: (id: string) => void }) {
  const tree = useMemo(() => {
    const epics = d.items.filter((i) => i.level === "EPIC");
    return epics.map((e) => ({ e, stories: d.items.filter((s) => s.level === "STORY" && s.parentKey === e.key).map((s) => ({ s, tasks: d.items.filter((t) => (t.level === "TASK" || t.level === "REPAIR") && (t.parentKey === s.key || d.items.some((x) => x.key === t.parentKey && x.parentKey === s.key))) })) }));
  }, [d.items]);
  const ops = d.items.filter((i) => i.key.startsWith("OPS."));
  const item = d.items.find((i) => i.key === sel);
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]" data-testid="backlog">
      <div className="space-y-4">
        {tree.map(({ e, stories }) => (
          <section key={e.key} className="rounded-lg border border-border">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2"><span className="mono text-2xs text-text-faint">{e.key}</span><span className="font-medium text-sm">{e.title}</span><Badge tone={STATUS_TONE[e.status]} className="ml-auto">{statusText(e.status)}</Badge></div>
            {stories.map(({ s, tasks }) => (
              <div key={s.key} className="border-b border-border-subtle px-3 py-2 last:border-0">
                <div className="flex items-center gap-2 text-sm"><span className="mono text-2xs text-text-faint">{s.key}</span>{s.title}<Badge tone={STATUS_TONE[s.status]} className="ml-auto">{statusText(s.status)}</Badge></div>
                <ul className="mt-1.5 space-y-1">
                  {tasks.map((t) => (
                    <li key={t.key}>
                      <button onClick={() => setSel(t.key)} data-item={t.key} data-status={t.status} aria-pressed={sel === t.key} className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-bg-raised", sel === t.key && "bg-bg-raised", t.level === "REPAIR" && "pl-6")}>
                        {VERIFY_ICON[t.verification]}
                        <span className="mono w-24 shrink-0 text-text-faint">{t.key}</span>
                        <span className="min-w-0 flex-1 truncate">{t.title}</span>
                        <span className="mono hidden text-2xs text-text-faint sm:inline">{t.kind.toLowerCase()} · {t.effort}pt est.</span>
                        {!t.executable && <span className="text-2xs text-text-faint">not executable</span>}
                        <Badge tone={STATUS_TONE[t.status]}>{statusText(t.status)}</Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))}
        {ops.length > 0 && <section className="rounded-lg border border-border p-3 text-xs"><div className="metric-label mb-1">From repository events</div>{ops.map((o) => <button key={o.key} onClick={() => setSel(o.key)} className="block hover:underline"><span className="mono">{o.key}</span> {o.title} — {statusText(o.status)}</button>)}</section>}
      </div>
      <aside className="rounded-lg border border-border p-4 text-sm" aria-label="Task detail" data-testid="item-detail">
        {!item ? <p className="text-text-muted">Select a task to see its acceptance criteria, dependencies, execution and evidence.</p> : (
          <div className="space-y-3">
            <div className="flex items-start gap-2"><div className="min-w-0"><div className="mono text-2xs text-text-faint">{item.key} · {item.level.toLowerCase()} · {item.kind.toLowerCase()}</div><h3 className="font-medium">{item.title}</h3></div><Badge tone={STATUS_TONE[item.status]} className="ml-auto">{statusText(item.status)}</Badge></div>
            <p className="text-xs text-text-muted">{item.description}</p>
            {item.blockedReason && <p className="rounded border border-warning/40 bg-warning/5 px-2 py-1.5 text-xs" role="status">{item.blockedReason}</p>}
            <Field label="Acceptance">{item.acceptance.map((a) => <li key={a}>{a}</li>)}</Field>
            <Field label="Verification required">{item.verifyBy.map((a) => <li key={a}>{a}</li>)}</Field>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div><div className="metric-label">Depends on</div>{item.dependsOn.length ? item.dependsOn.map((k) => <button key={k} onClick={() => setSel(k)} className="mono mr-1 hover:underline">{k}</button>) : "—"}</div>
              <div><div className="metric-label">Owner capability</div>{item.capabilities.join(", ") || "—"}</div>
              <div><div className="metric-label">Files</div><span className="mono">{item.files.join(", ") || "—"}</span></div>
              <div><div className="metric-label">Estimate · risk</div>{item.effort} pt (estimate) · {item.risk.toLowerCase()}</div>
            </div>
            <div className="text-xs"><div className="metric-label">Execution</div>{item.buildId ? <><button className="underline" onClick={() => openRun(item.buildId!)} data-testid="open-run">Open engineering run</button> · run {item.attempts}</> : item.mission ? <><Link className="underline" href={`/app/${companyId}/missions/${item.mission.id}`}>Mission {item.mission.id.slice(-6)}</Link> · {item.mission.status.toLowerCase()}</> : item.executable ? "Not started yet." : "Reviewed by a person (not executed)."}</div>
            <Field label={`Evidence (${item.evidence.length})`}>{item.evidence.length ? item.evidence.map((e, i) => <li key={i}><span className="mono text-text-faint">{e.kind}</span> {e.detail}</li>) : <li>No evidence recorded. Verification status: {item.verification.toLowerCase().replace(/_/g, " ")}.</li>}</Field>
            {canAct && (
              <div className="flex flex-wrap gap-2">
                {["BLOCKED", "FAILED", "CANCELLED"].includes(item.status) && <button onClick={() => act(`${item.key} reopened`, `${base}/items/${encodeURIComponent(item.key)}`, { status: "READY" }, "PATCH")} className="btn-secondary btn-sm">Reopen</button>}
                {!item.executable && ["TODO", "READY", "BLOCKED", "IN_REVIEW"].includes(item.status) && <button onClick={() => window.confirm("Accept this task without machine verification? It will be shown as 'accepted · unverified'.") && act(`${item.key} accepted unverified`, `${base}/items/${encodeURIComponent(item.key)}`, { status: "DONE_UNVERIFIED", note: "accepted by a person" }, "PATCH")} className="btn-ghost btn-sm">Accept unverified</button>}
                {item.buildId && item.status !== "IN_PROGRESS" && <button onClick={() => window.confirm(`Revert AURA's commits for ${item.key} on its branch? Commits made by people on that branch are kept, and the task is reopened.`) && act(`${item.key} rolled back`, `${base}/items/${encodeURIComponent(item.key)}/rollback`, {}, "POST")} className="btn-ghost btn-sm" data-testid="rollback">Roll back AURA changes</button>}
                {!["CANCELLED", "VERIFIED"].includes(item.status) && item.status !== "IN_PROGRESS" && <button onClick={() => act(`${item.key} cancelled`, `${base}/items/${encodeURIComponent(item.key)}`, { status: "CANCELLED" }, "PATCH")} className="btn-ghost btn-sm">Cancel task</button>}
              </div>
            )}
            <details className="text-xs"><summary className="cursor-pointer text-text-muted">History ({item.history.length})</summary><ol className="mt-1 space-y-0.5">{[...item.history].reverse().map((h, i) => <li key={i}><span className="text-text-faint">{timeAgo(h.at)} · {h.actor}</span> {h.change}</li>)}</ol></details>
          </div>
        )}
      </aside>
    </div>
  );
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="text-xs"><div className="metric-label">{label}</div><ul className="list-disc space-y-0.5 pl-4 text-text-muted">{children}</ul></div>
);

function DesignTab({ d, base, canAct, act }: { d: Detail; base: string; canAct: boolean; act: (l: string, u: string, b: unknown, m?: string) => Promise<any> }) {
  const arts = d.artifacts.filter((a) => ["DESIGN", "ARCHITECTURE", "HANDOFF"].includes(a.kind));
  const [fb, setFb] = useState("");
  if (!arts.length) return <p className="text-sm text-text-muted">No design or architecture artifacts yet. They're drafted when their tasks become ready after scope approval.</p>;
  return (
    <div className="space-y-5" data-testid="design">
      {arts.map((a) => (
        <section key={a.id} className={cn("rounded-lg border p-4", a.status === "SUPERSEDED" || a.status === "REVISION_REQUESTED" ? "border-border-subtle opacity-70" : "border-border")} data-artifact={a.kind} data-status={a.status}>
          <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{a.title}</h3><Badge tone={a.status === "APPROVED" ? "success" : a.status === "PROPOSED" ? "warning" : "neutral"}>{a.status.toLowerCase().replace(/_/g, " ")}</Badge><Badge>{a.source === "model" ? "model" : a.source === "engine" ? "engine" : "deterministic template"}</Badge><span className="text-2xs text-text-faint">by {a.producedBy} · {timeAgo(a.createdAt)}</span></div>
          {a.kind === "DESIGN" && <DesignPreview spec={a.content} />}
          {a.kind === "ARCHITECTURE" && (
            <div className="mt-2 space-y-2 text-xs">
              <p className="text-text-muted">{a.content.summary}</p>
              <Field label="Components">{a.content.components?.map((c: any) => <li key={c.name}><span className="mono">{c.name}</span> — {c.responsibility}</li>)}</Field>
              <Field label="Data model">{a.content.dataModel?.map((m: any) => <li key={m.entity}><span className="mono">{m.entity}</span>: {m.fields.join(", ")}</li>)}</Field>
              <Field label="Decisions">{a.content.decisions?.map((x: any) => <li key={x.id}><span className="mono">{x.id}</span> {x.decision} — {x.rationale}</li>)}</Field>
            </div>
          )}
          {a.kind === "HANDOFF" && (
            <div className="mt-2 text-xs"><p className="text-text-muted">{a.content.note}</p><Field label={`QA verifies (${a.content.acceptance?.length ?? 0})`}>{a.content.acceptance?.map((x: string) => <li key={x}>{x}</li>)}</Field><p className="mt-1">Consumed by: <span className="mono">{a.consumedBy.join(", ") || "—"}</span></p></div>
          )}
          {a.feedback.length > 0 && <ul className="mt-2 space-y-0.5 text-2xs text-text-faint">{a.feedback.map((f, i) => <li key={i}>{f.by}: {f.text}</li>)}</ul>}
          {canAct && a.status === "PROPOSED" && a.kind !== "HANDOFF" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={() => act(`${a.kind.toLowerCase()} approved`, `${base}/artifacts/${a.id}`, { decision: "approve" })} className="btn-primary btn-sm" data-testid={`approve-${a.kind.toLowerCase()}`}>Approve v{a.version}</button>
              <input value={fb} onChange={(e) => setFb(e.target.value)} placeholder="What should change?" className="input h-7 min-w-0 flex-1" aria-label="Revision feedback" />
              <button onClick={() => act("Revision requested", `${base}/artifacts/${a.id}`, { decision: "revise", feedback: fb }).then(() => setFb(""))} disabled={fb.trim().length < 5} className="btn-secondary btn-sm">Request revision</button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** Renders the design spec as a low-fidelity wireframe so it can be reviewed visually. */
function DesignPreview({ spec }: { spec: any }) {
  const [page, setPage] = useState(0);
  const [mobile, setMobile] = useState(false);
  const pg = spec.pages?.[page];
  if (!pg) return null;
  return (
    <div className="mt-3">
      <p className="text-xs text-text-muted">{spec.summary}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <div className="segmented" role="group" aria-label="Page">{spec.pages.map((x: any, i: number) => <button key={x.id} data-active={i === page} onClick={() => setPage(i)}>{x.title}</button>)}</div>
        <div className="segmented" role="group" aria-label="Viewport"><button data-active={!mobile} onClick={() => setMobile(false)}>desktop</button><button data-active={mobile} onClick={() => setMobile(true)}>mobile</button></div>
        <span className="flex gap-1">{Object.entries(spec.tokens?.colors ?? {}).map(([k, v]) => <span key={k} title={`${k} ${v}`} className="inline-block h-4 w-4 rounded-sm border border-border" style={{ background: v as string }} />)}</span>
      </div>
      <div className="mt-2 grid gap-4 lg:grid-cols-[auto_minmax(0,1fr)]">
        <div className={cn("rounded-md border border-border bg-bg-inset p-2", mobile ? "w-[220px]" : "w-full lg:w-[460px]")} aria-label={`Wireframe of ${pg.title}`} data-testid="wireframe">
          <div className={cn("grid gap-1.5", !mobile && pg.blocks.some((b: any) => b.kind === "filters") && "grid-cols-[110px_1fr]")}>
            {pg.blocks.map((b: any, i: number) => (
              <div key={i} className={cn("rounded border border-dashed border-border px-2 py-1.5 text-2xs text-text-muted", b.kind === "header" && "col-span-full font-medium text-text", b.kind === "list" && "min-h-[80px]", b.kind === "cta" && "col-span-full border-solid border-brand/50 text-center text-brand", b.kind === "filters" && !mobile && "row-span-2")}>
                {b.label}{b.note && <div className="text-text-faint">{b.note}</div>}
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-2 text-xs">
          <div><span className="metric-label">Purpose · </span>{pg.purpose}</div>
          <Field label="States">{Object.entries(pg.states).map(([k, v]) => <li key={k}><span className="mono">{k}</span>: {v as string}</li>)}</Field>
          <div><span className="metric-label">Responsive · </span>{mobile ? pg.responsive.mobile : pg.responsive.desktop}</div>
          <Field label="Accessibility">{spec.accessibility.map((x: string) => <li key={x}>{x}</li>)}</Field>
        </div>
      </div>
    </div>
  );
}

function Approvals({ d, base, canAct, act }: { d: Detail; base: string; canAct: boolean; act: (l: string, u: string, b: unknown, m?: string) => Promise<any> }) {
  const [note, setNote] = useState("");
  if (!d.approvals.length) return <p className="text-sm text-text-muted">No approval requests.</p>;
  return (
    <ul className="space-y-3" data-testid="approvals">
      {d.approvals.map((a) => (
        <li key={a.id} className="rounded-lg border border-border p-3 text-sm" data-approval={a.action} data-status={a.status}>
          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{a.summary}</span><Badge tone={a.status === "PENDING" ? "warning" : a.status === "APPROVED" ? "success" : "neutral"}>{a.status.toLowerCase()}</Badge><Badge>{a.actionClass.replace(/_/g, " ")}</Badge></div>
          <p className="mt-1 text-xs text-text-muted">{a.classHelp} Target: <span className="mono">{a.target}</span></p>
          {a.risks.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-text-muted">{a.risks.map((r) => <li key={r}>{r}</li>)}</ul>}
          {a.decidedBy && <p className="mt-1 text-2xs text-text-faint">{a.status.toLowerCase()} by {a.decidedBy} {a.decidedAt && timeAgo(a.decidedAt)}</p>}
          {canAct && a.status === "PENDING" && (
            <div className="mt-2 flex flex-wrap gap-2">
              <button onClick={() => act("Approved", `${base}/approvals/${a.id}`, { decision: "approve", note })} className="btn-primary btn-sm" data-testid={`approve-${a.action}`}>Approve</button>
              <button onClick={() => act("Rejected", `${base}/approvals/${a.id}`, { decision: "reject", note })} className="btn-secondary btn-sm">Reject</button>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="input h-7 min-w-0 flex-1" aria-label="Decision note" />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function ReleaseTab({ base, canAct, act, d }: { base: string; canAct: boolean; act: (l: string, u: string, b: unknown, m?: string) => Promise<any>; d: Detail }) {
  const { data: r, refetch } = useQuery<Readiness>(`${base}/release`);
  const rc = d.artifacts.find((a) => a.kind === "RELEASE_CANDIDATE");
  const dep = d.artifacts.find((a) => a.kind === "DEPLOYMENT");
  const icon = (s: string) => (s === "passed" ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : s === "failed" ? <XCircle className="h-3.5 w-3.5 text-danger" /> : <CircleDashed className="h-3.5 w-3.5 text-text-faint" />);
  return (
    <div className="space-y-5" data-testid="release">
      {!r ? <Skeleton className="h-40" /> : (
        <section>
          <p className="mb-2 text-xs text-text-muted">{r.note}</p>
          <p className="mono mb-2 text-2xs text-text-faint">{r.summary.passed} passed · {r.summary.failed} failed · {r.summary.notRun} not run · {r.summary.notApplicable} n/a</p>
          <ul className="divide-y divide-border-subtle rounded-lg border border-border text-sm">{r.checks.map((c) => <li key={c.id} className="flex items-start gap-2 px-3 py-2" data-check={c.id} data-status={c.status}>{icon(c.status)}<span className="w-72 shrink-0">{c.label}</span><span className="text-xs text-text-muted">{c.status.replace(/_/g, " ")} — {c.detail}</span></li>)}</ul>
          {canAct && <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => act("Release candidate built", `${base}/release`, { action: "candidate" }).then(refetch)} disabled={!r.canCreateCandidate} className="btn-primary btn-sm" title={r.canCreateCandidate ? "" : "Every executable task must be verified first"}><GitBranch className="h-3 w-3" /> Build release candidate</button>
            <button onClick={() => act("Publication requested", `${base}/release`, { action: "publish" })} disabled={rc?.status !== "APPROVED"} className="btn-secondary btn-sm">Request publish (PR)</button>
            <button onClick={() => act("Deployment requested", `${base}/release`, { action: "deploy" })} disabled={rc?.status !== "APPROVED"} className="btn-secondary btn-sm">Request production deploy</button>
          </div>}
        </section>
      )}
      {rc && (
        <section className="rounded-lg border border-border p-3 text-sm" data-testid="release-candidate">
          <div className="flex items-center gap-2"><h3 className="font-medium">{rc.title}</h3><Badge tone={rc.status === "APPROVED" ? "success" : "warning"}>{rc.status.toLowerCase().replace(/_/g, " ")}</Badge></div>
          <p className="mono mt-1 text-xs">{rc.content.branch} @ {rc.content.sha?.slice(0, 10)} ← {rc.content.base}</p>
          <p className="mt-1 text-xs">Integrated tests: {rc.content.test ? `${rc.content.test.passed}/${rc.content.test.total} passed (${rc.content.test.mode === "docker" ? "Docker sandbox" : "NOT executed"})` : "no suite"}</p>
          <pre className="mono mt-2 max-h-40 overflow-auto rounded bg-bg-inset p-2 text-2xs">{rc.content.diffStat}</pre>
        </section>
      )}
      {dep && <section className="rounded-lg border border-border p-3 text-sm"><h3 className="font-medium">{dep.title}</h3><p className="mt-1 text-xs">Status: <strong>{dep.content.status.replace(/_/g, " ").toLowerCase()}</strong>. Missing to actually deploy: {dep.content.missing.join(", ")}.</p></section>}
    </div>
  );
}

function RepoTab({ d, base }: { d: Detail; base: string }) {
  const [branch, setBranch] = useState<string | null>(null);
  const { data } = useQuery<{ branches: { name: string; sha: string }[]; diff: { stat: string; patch: string; commits: { sha: string; subject: string }[] } | null; detected: any; status: { configured: boolean; missing: string[] } }>(`${base}/repo${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`);
  if (!d.repo) return <p className="text-sm text-text-muted">No repository.</p>;
  return (
    <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]" data-testid="repository">
      <aside className="space-y-3 text-xs">
        <a href={`${base}/download`} className="btn-secondary btn-sm" data-testid="download-source">Download source (.tar.gz)</a>
        <div><div className="metric-label">Working repository</div><p>AURA-managed git repository (real commits). Default branch <span className="mono">{d.repo.defaultBranch}</span> is never written by agents.</p></div>
        <div><div className="metric-label">GitHub</div>{d.repo.provider === "local" ? <GithubLink base={base} companyId={d.product.companyId} /> : <p>{d.repo.provider} · <span className="mono">{d.repo.name}</span></p>}</div>
        {data?.detected && <div><div className="metric-label">Detected</div><p>{data.detected.language}{data.detected.framework ? ` · ${data.detected.framework}` : ""} · tests: {data.detected.testCommand ?? "none"}</p></div>}
        <div><div className="metric-label">Branches</div><ul className="space-y-0.5">{data?.branches.map((b) => <li key={b.name}><button onClick={() => setBranch(b.name)} className={cn("mono hover:underline", branch === b.name && "text-brand")}>{b.name}</button> <span className="text-text-faint">{b.sha.slice(0, 8)}</span></li>)}</ul></div>
        <div><div className="metric-label">Git operations</div><ul className="space-y-0.5">{d.gitOps.map((g) => <li key={g.id}><span className="mono">{g.op}</span> {g.branch} <span className={g.status === "SUCCEEDED" ? "text-success" : "text-danger"}>{g.status.toLowerCase()}</span> {g.url ? <a className="underline" href={g.url} target="_blank" rel="noreferrer">PR</a> : null}<div className="text-text-faint">{g.detail}</div></li>)}</ul></div>
      </aside>
      <div>
        {!data?.diff ? <p className="text-sm text-text-muted">Select a branch to see its commits and diff against {d.repo.defaultBranch}.</p> : (
          <div className="text-xs" data-testid="branch-diff">
            <ul className="mb-2">{data.diff.commits.map((c) => <li key={c.sha}><span className="mono text-text-faint">{c.sha.slice(0, 8)}</span> {c.subject}</li>)}</ul>
            <pre className="mono max-h-[520px] overflow-auto rounded-md border border-border bg-bg-inset p-3 text-2xs leading-relaxed">{data.diff.patch.split("\n").map((l, i) => <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "text-success" : l.startsWith("-") && !l.startsWith("---") ? "text-danger" : ""}>{l || " "}</div>)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineTab({ base, version }: { base: string; version: number }) {
  const { data, refetch } = useQuery<{ at: string; kind: string; actor: string; text: string }[]>(`${base}/timeline`);
  const [kind, setKind] = useState("");
  useEffect(() => {
    if (version > 0) refetch();
  }, [version, refetch]);
  const rows = (data ?? []).filter((r) => !kind || r.kind === kind);
  return (
    <div data-testid="product-timeline">
      <div className="segmented mb-3" role="group" aria-label="Filter">{["", "phase", "item", "approval", "git", "artifact"].map((k) => <button key={k} data-active={kind === k} onClick={() => setKind(k)}>{k || "all"}</button>)}</div>
      {!data ? <Skeleton className="h-40" /> : rows.length === 0 ? <p className="text-sm text-text-muted">No events.</p> : (
        <ol className="divide-y divide-border-subtle rounded-lg border border-border text-xs">{rows.map((r, i) => <li key={i} className="flex gap-3 px-3 py-1.5"><span className="mono w-16 shrink-0 text-text-faint">{timeAgo(r.at)}</span><span className="mono w-16 shrink-0 text-text-muted">{r.kind}</span><span className="min-w-0 flex-1">{r.text}</span><span className="text-text-faint">{r.actor}</span></li>)}</ol>
      )}
    </div>
  );
}

interface RunRow { id: string; companyId: string; productId: string; itemKey: string; status: string; phase: string; branch: string; attempt: number; maxRepairs: number; costUsd: number; createdAt: string; finishedAt: string | null; failure: string }
interface RunDetail extends RunRow {
  headSha: string | null; baseSha: string | null; summary: string; tokensIn: number; tokensOut: number; modelCalls: number; toolCalls: number; sandboxMs: number; changed: string[];
  budgetUsd: number; stopReason: string; impact: Impact; defects: { id: string; title: string; category: string; status: string; occurrences: number; commandRunId: string; fixedByCommandRunId: string | null }[];
  criteria: { text: string; status: string; evidence: string }[];
  findings: { source: string; severity: string; title: string; detail: string; evidence: string; blocking: boolean }[];
  commands: { id: string; purpose: string; actor: string; command: string; network: boolean; exitCode: number | null; timedOut: boolean; durationMs: number; truncated: boolean; createdAt: string }[];
  job: { status: string; attempts: number; maxAttempts: number; lastError: string; errorKind: string | null; runAt: string } | null;
  orchestration: { risk?: string; riskReasons?: string[]; reviewers?: string[]; reviewPolicy?: string; gatePolicy?: string; inputs?: { design: string | null; architecture: string | null }; attempts?: { attempt: number; passed: boolean; recovery?: string; decision?: string | null; disagreement?: boolean }[] };
  contextManifest: { id: string; provenance: string; chars: number }[];
  browser: { status?: string; reason?: string; routes?: { route: string; viewport: string; httpStatus: number | null; screenshot: string | null }[]; journeys?: { name: string; status: string; detail: string }[]; findings?: { kind: string; route: string; viewport: string; detail: string; blocking: boolean }[] };
}

/** Engineering runs: phase, attempts, criteria with evidence, findings and every command with its REAL output. */
function RunsTab({ companyId, productId, run, setRun, canAct, version }: { companyId: string; productId: string; run: string | null; setRun: (r: string | null) => void; canAct: boolean; version: number }) {
  const { toast } = useApp();
  const { data: runs, refetch } = useQuery<RunRow[]>(`/api/companies/${companyId}/builds?product=${productId}`, 5000);
  const sel = run ?? runs?.[0]?.id ?? null;
  const { data: r, refetch: refetchRun } = useQuery<RunDetail>(sel ? `/api/companies/${companyId}/builds/${sel}` : null, 4000);
  const [open, setOpen] = useState<string | null>(null);
  const { data: out } = useQuery<{ output: string; exitCode: number | null; truncated: boolean } | null>(open && sel ? `/api/companies/${companyId}/builds/${sel}?command=${open}` : null);
  useEffect(() => {
    if (version > 0) {
      refetch();
      refetchRun();
    }
  }, [version, refetch, refetchRun]);
  async function act(action: "cancel" | "retry") {
    try {
      await fetchJSON(`/api/companies/${companyId}/builds/${sel}`, { method: "POST", body: JSON.stringify({ action }) });
      toast({ title: action === "cancel" ? "Run cancelled" : "Run queued again", level: "success" });
      refetchRun();
      refetch();
    } catch (e) {
      toast({ title: `${action} failed`, description: (e as Error).message, level: "danger" });
    }
  }
  if (!runs) return <Skeleton className="h-40" />;
  if (!runs.length) return <p className="text-sm text-text-muted">No engineering runs yet. Approve the scope and press Run team: each ready task gets its own run.</p>;
  const tone = (s: string) => (s === "VERIFIED" ? "success" : s === "FAILED" ? "danger" : s === "BLOCKED" ? "warning" : s === "CANCELLED" ? "neutral" : "info");
  return (
    <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]" data-testid="runs">
      <ul className="space-y-1 text-sm">
        {runs.map((x) => (
          <li key={x.id}><button onClick={() => setRun(x.id)} aria-pressed={sel === x.id} className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-bg-raised", sel === x.id && "bg-bg-raised")}>
            <span className="mono text-xs text-text-faint">{x.itemKey}</span><Badge tone={tone(x.status)}>{x.status === "RUNNING" ? x.phase : x.status.toLowerCase()}</Badge><span className="ml-auto text-2xs text-text-faint">{timeAgo(x.createdAt)}</span>
          </button></li>
        ))}
      </ul>
      {!r ? <Skeleton className="h-60" /> : (
        <div className="space-y-4 text-sm" data-testid="run-detail" data-status={r.status}>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{r.itemKey}</h3><Badge tone={tone(r.status)}>{r.status.toLowerCase()}</Badge>
            {["QUEUED", "RUNNING"].includes(r.status) && <span className="flex items-center gap-1 text-xs text-text-muted"><Loader2 className="h-3 w-3 animate-spin" /> {r.phase}{r.attempt ? ` · attempt ${r.attempt + 1} of ${r.maxRepairs + 1}` : ""}</span>}
            <span className="mono text-2xs text-text-faint">{r.branch}{r.headSha ? ` @ ${r.headSha.slice(0, 8)}` : ""}</span>
            {canAct && ["QUEUED", "RUNNING"].includes(r.status) && <button onClick={() => act("cancel")} className="btn-ghost btn-sm ml-auto">Cancel run</button>}
            {canAct && ["BLOCKED", "FAILED", "CANCELLED"].includes(r.status) && <button onClick={() => act("retry")} className="btn-secondary btn-sm ml-auto" data-testid="retry-run">Retry</button>}
          </div>
          {r.failure && <p className="whitespace-pre-wrap rounded border border-warning/40 bg-warning/5 px-2.5 py-2 text-xs" role="status">{r.failure.slice(0, 1500)}</p>}
          {r.job && r.job.status === "QUEUED" && r.job.lastError && <p className="text-xs text-text-muted">Will retry automatically ({r.job.attempts}/{r.job.maxAttempts} attempts used): {r.job.lastError}</p>}
          <p className="mono text-2xs text-text-faint">{r.modelCalls} model calls · {r.toolCalls} tool calls · {(r.tokensIn + r.tokensOut).toLocaleString()} tokens · ${r.costUsd.toFixed(4)} est. of ${r.budgetUsd.toFixed(2)} run budget · sandbox {(r.sandboxMs / 1000).toFixed(1)} s</p>
          {r.defects.length > 0 && <section><div className="metric-label mb-1">Defects</div><ul className="space-y-0.5 text-xs">{r.defects.map((x) => <li key={x.id}><Badge tone={x.status === "FIXED" ? "success" : x.status === "ABANDONED" ? "neutral" : "danger"}>{x.status.toLowerCase()}</Badge> {x.title} <span className="text-text-faint">({x.category.replace("_", " ")}, seen {x.occurrences}×{x.fixedByCommandRunId ? ", fix proven by a passing check" : ""})</span></li>)}</ul></section>}
          {r.criteria.length > 0 && (
            <section><div className="metric-label mb-1">Acceptance criteria</div><ul className="space-y-1 text-xs">{r.criteria.map((c, i) => <li key={i} className="flex gap-2">{c.status === "met" ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> : c.status === "not_met" ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" /> : <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-faint" />}<span><span className="font-medium">{c.text}</span> <span className="text-text-muted">— {c.status.replace("_", " ")}: {c.evidence}</span></span></li>)}</ul></section>
          )}
          {r.findings.length > 0 && (
            <section><div className="metric-label mb-1">Findings</div><ul className="space-y-1 text-xs">{r.findings.map((f, i) => <li key={i}><Badge tone={f.blocking ? "danger" : "neutral"}>{f.source} · {f.severity}{f.blocking ? " · blocking" : ""}</Badge> <span className="font-medium">{f.title}</span> <span className="text-text-muted">{f.detail}</span></li>)}</ul></section>
          )}
          {r.browser?.status && (
            <section data-testid="browser-evidence">
              <div className="metric-label mb-1">Browser verification <Badge tone={r.browser.status === "passed" ? "success" : r.browser.status === "failed" ? "danger" : "warning"}>{r.browser.status === "unavailable" ? "not run" : r.browser.status}</Badge></div>
              {r.browser.status === "unavailable" ? <p className="text-xs text-text-muted">{r.browser.reason} — browser-visible behaviour is unverified.</p> : (
                <>
                  <ul className="space-y-0.5 text-xs">{(r.browser.journeys ?? []).map((j) => <li key={j.name}><Badge tone={j.status === "passed" ? "success" : j.status === "failed" ? "danger" : "neutral"}>{j.status.replace("_", " ")}</Badge> {j.name} <span className="text-text-muted">— {j.detail}</span></li>)}</ul>
                  <div className="mt-2 flex flex-wrap gap-2">{(r.browser.routes ?? []).filter((x) => x.screenshot).map((x) => <a key={`${x.route}-${x.viewport}`} href={x.screenshot!} target="_blank" rel="noreferrer" className="block rounded border border-border p-1 text-2xs text-text-muted hover:border-border-strong"><img src={x.screenshot!} alt={`Screenshot of ${x.route} at ${x.viewport}`} className="h-28 w-auto object-cover object-top" loading="lazy" /><span className="mono">{x.route} · {x.viewport}</span></a>)}</div>
                </>
              )}
            </section>
          )}
          {r.orchestration?.risk && (
            <details className="text-xs" data-testid="orchestration">
              <summary className="cursor-pointer text-text-muted">How this run was coordinated: {r.orchestration.risk.toLowerCase()} risk · {r.orchestration.reviewers?.length ?? 0} reviewers · gate {r.orchestration.gatePolicy}</summary>
              <div className="mt-1 space-y-1 text-text-muted">
                <p>{r.orchestration.reviewPolicy}{r.orchestration.riskReasons?.length ? ` — sensitive: ${r.orchestration.riskReasons.join(", ")}` : ""}</p>
                <p>Inputs: {[r.orchestration.inputs?.architecture, r.orchestration.inputs?.design].filter(Boolean).join(" · ") || "no upstream design/architecture artifacts"}</p>
                <ul>{(r.orchestration.attempts ?? []).map((a) => <li key={a.attempt}>Attempt {a.attempt + 1}: {a.passed ? "tests passed" : "tests failed"}{a.recovery ? ` → recovery: ${a.recovery.replace(/_/g, " ")}` : ""}{a.decision ? ` · ${a.decision}` : ""}{a.disagreement ? " (reviewers disagreed)" : ""}</li>)}</ul>
                {r.contextManifest?.length > 0 && <p>Context given to the engineer: {r.contextManifest.map((c) => `${c.id} (${c.provenance})`).join("; ")}</p>}
              </div>
            </details>
          )}
          <RunLearning companyId={r.companyId} productId={r.productId} buildId={r.id} itemKey={r.itemKey} canAct={canAct} />
          {r.stopReason && <p className="text-xs text-text-muted">Stopped early: {r.stopReason.replace(/_/g, " ")}</p>}
          <ImpactView impact={r.impact} />
          {r.changed.length > 0 && <section><div className="metric-label mb-1">Changed files</div><p className="mono text-xs text-text-muted">{r.changed.join(" · ")}</p></section>}
          <section>
            <div className="metric-label mb-1">Commands ({r.commands.length}) — executed in the isolated sandbox</div>
            <ul className="divide-y divide-border-subtle rounded-lg border border-border text-xs" data-testid="commands">
              {r.commands.map((c) => (
                <li key={c.id}>
                  <button onClick={() => setOpen(open === c.id ? null : c.id)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-raised" data-command={c.purpose} data-exit={c.exitCode ?? ""}>
                    <span className={cn("mono w-10", c.exitCode === 0 ? "text-success" : "text-danger")}>{c.timedOut ? "T/O" : `exit ${c.exitCode}`}</span>
                    <span className="mono flex-1 truncate">$ {c.command}</span>
                    <span className="text-2xs text-text-faint">{c.actor}{c.network ? " · network" : ""} · {(c.durationMs / 1000).toFixed(1)}s</span>
                  </button>
                  {open === c.id && <pre className="mono max-h-80 overflow-auto bg-bg-inset px-3 py-2 text-2xs leading-relaxed">{out ? out.output || "(no output)" : "loading…"}{out?.truncated ? "\n… (output truncated)" : ""}</pre>}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

/** Link this product to a repository of the connected GitHub App installation. */
function GithubLink({ base, companyId }: { base: string; companyId: string }) {
  const { toast } = useApp();
  const [load, setLoad] = useState(false);
  const { data: repos, error } = useQuery<{ fullName: string; defaultBranch: string }[]>(load ? `/api/companies/${companyId}/github/repos` : null);
  const [choice, setChoice] = useState("");
  const [mode, setMode] = useState<"publish" | "import">("publish");
  if (!load) return <button onClick={() => setLoad(true)} className="btn-secondary btn-sm mt-1">Link a GitHub repository</button>;
  if (error) return <p className="text-text-muted">{error}. Connect GitHub in <Link className="underline" href={`/app/${companyId}/settings?tab=integrations`}>Settings → Integrations</Link>.</p>;
  if (!repos) return <Skeleton className="h-8" />;
  return (
    <div className="mt-1 space-y-2">
      <select value={choice} onChange={(e) => setChoice(e.target.value)} className="input h-7" aria-label="Repository"><option value="">Choose a repository…</option>{repos.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}</select>
      <div className="segmented" role="group" aria-label="Link mode"><button data-active={mode === "publish"} onClick={() => setMode("publish")}>Publish AURA&apos;s work there</button><button data-active={mode === "import"} onClick={() => setMode("import")}>Import its code</button></div>
      <button disabled={!choice} onClick={async () => { try { await fetchJSON(`${base}/github`, { method: "PUT", body: JSON.stringify({ fullName: choice, mode }) }); toast({ title: "Repository linked", level: "success" }); location.reload(); } catch (e) { toast({ title: "Link failed", description: (e as Error).message, level: "danger" }); } }} className="btn-primary btn-sm">Link</button>
    </div>
  );
}


/** What the run learned from (retrieval explanation), its recorded outcome/attributions, and a correction box. */
function RunLearning({ companyId, productId, buildId, itemKey, canAct }: { companyId: string; productId: string; buildId: string; itemKey: string; canAct: boolean }) {
  const { data, refetch } = useQuery<{ retrieved: { source: string; label: string; status: string; reason: string }[]; outcome: { outcome: string; attempts: number } | null; attributions: { id: string; attempt: number; category: string; rootCause: string; status: string; verification: string }[] }>(`/api/companies/${companyId}/learning/runs/${buildId}`);
  const { toast } = useApp();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await fetchJSON(`/api/companies/${companyId}/learning/feedback`, { method: "POST", body: JSON.stringify({ text, productId, itemKey, buildId }) });
      toast({ title: "Correction saved", description: "It becomes concrete criteria/instructions for this product's next runs. You can review it under Engineering intelligence → Feedback.", level: "success" });
      setText("");
      refetch();
    } catch (err) {
      toast({ title: "Not saved", description: (err as Error).message, level: "danger" });
    }
    setBusy(false);
  }
  if (!data) return null;
  return (
    <details className="text-xs" data-testid="run-learning">
      <summary className="cursor-pointer text-text-muted">Learning: {data.retrieved.length} item(s) retrieved for this run{data.attributions.length ? ` · ${data.attributions.length} failure cause(s) recorded` : ""}</summary>
      <div className="mt-1 space-y-2">
        {data.retrieved.length > 0 && <ul className="text-text-muted">{data.retrieved.map((m, i) => <li key={i}><Badge tone="neutral">{m.status.toLowerCase()}</Badge> {m.source}: {m.label} — {m.reason}</li>)}</ul>}
        {data.attributions.length > 0 && <ul>{data.attributions.map((a) => <li key={a.id}>Attempt {a.attempt + 1}: <span className="font-medium">{a.category.replace(/_/g, " ")}</span> ({a.status.toLowerCase()}) — {a.rootCause} <span className="text-text-faint">[fix {a.verification.toLowerCase()}]</span></li>)}</ul>}
        {canAct && <form onSubmit={send} className="flex gap-2"><input aria-label={`Correction for ${itemKey}`} className="input h-7 flex-1" placeholder="Tell AURA what is wrong (e.g. the mobile layout is broken)" value={text} onChange={(e) => setText(e.target.value)} minLength={3} maxLength={2000} required /><button disabled={busy || text.trim().length < 3} className="btn-secondary btn-sm">Save correction</button></form>}
      </div>
    </details>
  );
}

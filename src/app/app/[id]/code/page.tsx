"use client";

import dynamic from "next/dynamic";
import { Suspense, use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, Code2, Columns2, FlaskConical, GitPullRequest, Loader2, MonitorPlay, PanelBottomClose, PanelBottomOpen, PanelRightClose, PanelRightOpen, Play, Rows2, Save, Square, Target, X } from "lucide-react";
import { useQuery, useMutation, fetchJSON } from "@/hooks/useApi";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { EmptyState, ErrorState, Skeleton, Badge } from "@/components/ui/primitives";
import { FileTree, type FileEntry } from "@/components/devspace/tree";
import { ReviewPanel, ChangeStatus, type ChangeDetail } from "@/components/devspace/review";
import { useApp } from "@/lib/store";
import { cn, timeAgo } from "@/lib/utils";

// CodeMirror touches the DOM; load it client-side only.
const CodeEditor = dynamic(() => import("@/components/devspace/editor").then((m) => m.CodeEditor), { ssr: false, loading: () => <Skeleton className="h-full" /> });
const DiffEditor = dynamic(() => import("@/components/devspace/editor").then((m) => m.DiffEditor), { ssr: false, loading: () => <Skeleton className="h-full" /> });

interface Project {
  name: string;
  revision: number;
  template: string | null;
  files: FileEntry[];
  canEdit: boolean;
  canDecide: boolean;
  checks: { id: string; label: string; supported: boolean; reason: string | null }[];
  preview: { available: boolean; reason: string };
}
interface ChangeRow {
  id: string;
  path: string;
  author: string;
  missionId: string | null;
  taskKey: string | null;
  status: string;
  added: number;
  removed: number;
  createdAt: string;
}
interface CheckRun {
  id: string;
  check: string;
  command: string;
  revision: number;
  changeId: string | null;
  status: string;
  mode: string;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  total: number | null;
  failedNames: string;
  truncated: boolean;
  requestedBy: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  output?: string;
}
interface ActivityItem {
  id: string;
  at: string;
  actor: string;
  kind: string;
  text: string;
  status: string;
  open?: { type: "file" | "change" | "check" | "mission"; id: string; path?: string };
}
interface OpenFile {
  path: string;
  content: string; // saved content
  draft: string; // editor content
  rev: number;
}

type Tab = { kind: "file"; path: string } | { kind: "change"; id: string };
const tabKey = (t: Tab) => (t.kind === "file" ? `f:${t.path}` : `c:${t.id}`);

export default function DevspacePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="p-4"><Skeleton className="h-80" /></div>}>
      <Devspace params={params} />
    </Suspense>
  );
}

function Devspace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const search = useSearchParams();
  const { toast } = useApp();
  const base = `/api/companies/${id}/devspace`;
  const { data: project, error, loading, refetch } = useQuery<Project>(base, 20000);
  const { data: changes, refetch: refetchChanges } = useQuery<ChangeRow[]>(`${base}/changes`, 10000);
  const { data: runs, refetch: refetchRuns } = useQuery<CheckRun[]>(`${base}/checks`, 5000);
  const { data: activity, refetch: refetchActivity } = useQuery<ActivityItem[]>(`${base}/activity`, 10000);
  const { version } = useLiveEvents(id);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, OpenFile>>({});
  const [detail, setDetail] = useState<Record<string, ChangeDetail>>({});
  const [diffMode, setDiffMode] = useState<"inline" | "split">("inline");
  const [right, setRight] = useState<"review" | "activity" | "changes" | null>("changes");
  const [bottom, setBottom] = useState(true);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const saveMut = useMutation<{ path: string; content: string; expectedRev: number }, { revision: number; files: { path: string; rev: number }[]; conflicted: string[] }>("PUT");

  const refreshAll = useCallback(() => {
    refetch();
    refetchChanges();
    refetchRuns();
    refetchActivity();
  }, [refetch, refetchChanges, refetchRuns, refetchActivity]);

  useEffect(() => {
    if (version > 0) refreshAll();
  }, [version, refreshAll]);

  const openFile = useCallback(async (path: string) => {
    const t: Tab = { kind: "file", path };
    setTabs((ts) => (ts.some((x) => tabKey(x) === tabKey(t)) ? ts : [...ts, t]));
    setActive(tabKey(t));
    if (files[path]) return;
    try {
      const f = await fetchJSON<{ path: string; content: string; rev: number }>(`${base}/file?path=${encodeURIComponent(path)}`);
      setFiles((m) => ({ ...m, [path]: { path, content: f.content, draft: f.content, rev: f.rev } }));
    } catch (e) {
      toast({ title: `Couldn't open ${path}`, description: (e as Error).message, level: "danger" });
      setTabs((ts) => ts.filter((x) => tabKey(x) !== tabKey(t)));
    }
  }, [base, files, toast]);

  const loadChange = useCallback(async (cid: string) => {
    try {
      const c = await fetchJSON<ChangeDetail>(`${base}/changes/${cid}`);
      setDetail((d) => ({ ...d, [cid]: c }));
      return c;
    } catch (e) {
      toast({ title: "Couldn't load the change", description: (e as Error).message, level: "danger" });
      return null;
    }
  }, [base, toast]);

  const openChange = useCallback(async (cid: string) => {
    const t: Tab = { kind: "change", id: cid };
    setTabs((ts) => (ts.some((x) => tabKey(x) === tabKey(t)) ? ts : [...ts, t]));
    setActive(tabKey(t));
    setRight("review");
    await loadChange(cid);
  }, [loadChange]);

  // Deep links: ?change=… / ?file=…
  useEffect(() => {
    const c = search.get("change");
    const f = search.get("file");
    if (c) openChange(c);
    else if (f) openFile(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = (p: string) => !!files[p] && files[p].draft !== files[p].content;
  const anyDirty = Object.keys(files).some(dirty);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (anyDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [anyDirty]);

  function closeTab(t: Tab) {
    if (t.kind === "file" && dirty(t.path) && !window.confirm(`Discard unsaved changes to ${t.path}?`)) return;
    setTabs((ts) => {
      const next = ts.filter((x) => tabKey(x) !== tabKey(t));
      if (active === tabKey(t)) setActive(next.length ? tabKey(next[next.length - 1]) : null);
      return next;
    });
    if (t.kind === "file") setFiles((m) => { const n = { ...m }; delete n[t.path]; return n; });
  }

  async function save(path: string) {
    const f = files[path];
    if (!f || !dirty(path)) return;
    try {
      const r = await saveMut.mutate(`${base}/file`, { path, content: f.draft, expectedRev: f.rev });
      setFiles((m) => ({ ...m, [path]: { ...f, content: f.draft, rev: r.files[0].rev } }));
      toast({ title: `Saved ${path}`, description: `Project revision r${r.revision}${r.conflicted.length ? ` · ${r.conflicted.length} pending agent change(s) now conflict` : ""}`, level: r.conflicted.length ? "warning" : "success" });
      refreshAll();
    } catch (e) {
      toast({ title: "Not saved", description: (e as Error).message, level: "danger" });
    }
  }

  async function reloadFile(path: string) {
    const f = await fetchJSON<{ content: string; rev: number }>(`${base}/file?path=${encodeURIComponent(path)}`);
    setFiles((m) => ({ ...m, [path]: { path, content: f.content, draft: f.content, rev: f.rev } }));
  }

  async function changeAction(cid: string, action: "accept" | "reject" | "revert" | "revise", extra: Record<string, unknown> = {}) {
    setBusy(action);
    try {
      const r = await fetchJSON<{ status?: string; revision?: number; missionId?: string }>(`${base}/changes/${cid}`, { method: "POST", body: JSON.stringify({ action, ...extra }) });
      toast({ title: action === "accept" ? `Accepted · applied as r${r.revision}` : action === "revert" ? `Reverted · r${r.revision}` : action === "revise" ? "Revision requested — new mission planned" : "Change rejected", level: action === "reject" ? "info" : "success" });
      const c = detail[cid];
      if (c && files[c.path]) await reloadFile(c.path);
      if (action === "revise" && r.missionId) router.push(`/app/${id}/missions/${r.missionId}`);
    } catch (e) {
      toast({ title: "Action not completed", description: (e as Error).message, level: "danger" });
    } finally {
      setBusy(null);
      await loadChange(cid);
      refreshAll();
    }
  }

  async function runCheck(check: string, changeId?: string) {
    setBusy(changeId ? "check" : `check:${check}`);
    setBottom(true);
    try {
      const r = await fetchJSON<CheckRun>(`${base}/checks`, { method: "POST", body: JSON.stringify({ check, changeId }) });
      setSelectedRun(r.id);
    } catch (e) {
      toast({ title: "Check not run", description: (e as Error).message, level: "danger" });
    } finally {
      setBusy(null);
      refreshAll();
      if (changeId) loadChange(changeId);
    }
  }

  async function cancelRun(runId: string) {
    try {
      await fetchJSON(`${base}/checks/${runId}`, { method: "DELETE" });
    } catch (e) {
      toast({ title: "Couldn't cancel", description: (e as Error).message, level: "danger" });
    }
    refetchRuns();
  }

  async function importSample() {
    setBusy("import");
    try {
      await fetchJSON(`${base}/import`, { method: "POST", body: JSON.stringify({ template: "checkout-validation" }) });
      refreshAll();
    } catch (e) {
      toast({ title: "Import failed", description: (e as Error).message, level: "danger" });
    } finally {
      setBusy(null);
    }
  }

  async function startMission() {
    setBusy("mission");
    try {
      const r = await fetchJSON<{ missionId: string }>(`${base}/missions`, { method: "POST", body: JSON.stringify({ objective: "Find and fix a validation bug in a sample checkout module: inspect the checkout validation code, fix the failing validation test, run the tests." }) });
      router.push(`/app/${id}/missions/${r.missionId}`);
    } catch (e) {
      toast({ title: "Mission not started", description: (e as Error).message, level: "danger" });
      setBusy(null);
    }
  }

  const pendingPaths = useMemo(() => new Set((changes ?? []).filter((c) => ["PROPOSED", "VERIFICATION_PENDING", "VERIFICATION_FAILED", "VERIFIED"].includes(c.status)).map((c) => c.path)), [changes]);
  const activeTab = tabs.find((t) => tabKey(t) === active) ?? null;
  const activeChange = activeTab?.kind === "change" ? detail[activeTab.id] : right === "review" ? Object.values(detail).at(-1) : undefined;

  if (error && !project) return <div className="p-4"><ErrorState message={error} onRetry={refetch} /></div>;
  if (loading && !project) return <div className="space-y-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-96" /></div>;
  if (!project) return null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="devspace">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <Code2 className="h-4 w-4 text-text-faint" />
        <span className="text-sm font-medium">{project.name}</span>
        <span className="mono text-2xs text-text-faint" data-testid="project-revision">r{project.revision}</span>
        {!project.canEdit && <Badge>read-only</Badge>}
        <div className="ml-auto flex items-center gap-1.5">
          {project.checks.map((c) => (
            <button key={c.id} onClick={() => runCheck(c.id)} disabled={!project.canEdit || !!busy} title={c.supported ? `Run ${c.label} in the sandbox` : c.reason ?? ""} className={cn("btn-ghost btn-sm", !c.supported && "text-text-faint")} data-check={c.id}>
              {busy === `check:${c.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} {c.id}{!c.supported && " (n/a)"}
            </button>
          ))}
          <button onClick={startMission} disabled={!project.canEdit || !!busy || !project.files.some((f) => f.path === "src/checkout/validation.js")} className="btn-secondary btn-sm" title="Start the sample mission on the current project revision">
            {busy === "mission" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Target className="h-3 w-3" />} Fix validation bug (mission)
          </button>
          <button onClick={() => setBottom((v) => !v)} className="icon-btn" aria-label={bottom ? "Hide checks panel" : "Show checks panel"}>{bottom ? <PanelBottomClose className="h-4 w-4" /> : <PanelBottomOpen className="h-4 w-4" />}</button>
          <button onClick={() => setRight((v) => (v ? null : "changes"))} className="icon-btn" aria-label={right ? "Hide side panel" : "Show side panel"}>{right ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}</button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Explorer */}
        <aside className="hidden w-60 shrink-0 border-r border-border md:block" aria-label="Explorer">
          {project.files.length === 0 ? (
            <EmptyState icon={Code2} compact title="Empty project" description="Import the sample checkout project to inspect real source and tests, run them in the sandbox, and review agent changes." action={project.canEdit ? <button onClick={importSample} disabled={!!busy} className="btn-primary btn-sm" data-testid="import-sample">{busy === "import" && <Loader2 className="h-3 w-3 animate-spin" />} Import sample project</button> : undefined} />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              {project.canEdit && !project.files.some((f) => f.path === "src/checkout/validation.js") && (
                <div className="border-b border-border-subtle p-2">
                  <button onClick={importSample} disabled={!!busy} className="btn-secondary btn-sm w-full" data-testid="import-sample">{busy === "import" && <Loader2 className="h-3 w-3 animate-spin" />} Import sample checkout module</button>
                  <p className="mt-1 text-2xs text-text-faint">Adds the fixture files; existing files are never overwritten.</p>
                </div>
              )}
              <div className="min-h-0 flex-1"><FileTree files={project.files} active={activeTab?.kind === "file" ? activeTab.path : null} changed={pendingPaths} onOpen={openFile} /></div>
            </div>
          )}
        </aside>

        {/* Editor / diff */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-end overflow-x-auto border-b border-border bg-bg-raised" role="tablist">
            {tabs.map((t) => {
              const k = tabKey(t);
              const label = t.kind === "file" ? t.path.split("/").pop() : `Δ ${detail[t.id]?.path.split("/").pop() ?? "change"}`;
              return (
                <div key={k} role="tab" aria-selected={active === k} className={cn("group flex h-8 items-center gap-1.5 border-r border-border px-2.5 text-xs", active === k ? "bg-bg-inset text-text" : "text-text-muted hover:text-text")}>
                  <button onClick={() => setActive(k)} className="mono max-w-[180px] truncate" title={t.kind === "file" ? t.path : detail[t.id]?.path}>{label}</button>
                  {t.kind === "file" && dirty(t.path) && <span className="dot bg-warning" aria-label="unsaved changes" data-testid="dirty-dot" />}
                  <button onClick={() => closeTab(t)} className="opacity-50 hover:opacity-100" aria-label={`Close ${label}`}><X className="h-3 w-3" /></button>
                </div>
              );
            })}
          </div>
          <div className="min-h-0 flex-1">
            {!activeTab ? (
              <div className="p-6"><EmptyState icon={Code2} compact title="Nothing open" description={project.files.length ? "Open a file from the explorer, or select an agent change to review its diff." : "Import the sample project to begin."} /></div>
            ) : activeTab.kind === "file" ? (
              files[activeTab.path] ? (
                <div className="flex h-full flex-col">
                  <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border-subtle px-3 text-2xs text-text-faint">
                    <span className="mono truncate">{activeTab.path}</span>
                    <span className="mono">file r{files[activeTab.path].rev}</span>
                    {project.files.find((f) => f.path === activeTab.path)?.protected && <Badge>protected · read-only</Badge>}
                    <span className="ml-auto">{dirty(activeTab.path) ? "unsaved" : "saved"}</span>
                    {project.canEdit && <button onClick={() => save(activeTab.path)} disabled={!dirty(activeTab.path) || saveMut.loading} className="btn-ghost btn-sm h-5" data-testid="save-file"><Save className="h-3 w-3" /> Save (⌘S)</button>}
                  </div>
                  <div className="min-h-0 flex-1">
                    <CodeEditor
                      path={activeTab.path}
                      value={files[activeTab.path].draft}
                      readOnly={!project.canEdit || !!project.files.find((f) => f.path === activeTab.path)?.protected}
                      onChange={(v) => setFiles((m) => ({ ...m, [activeTab.path]: { ...m[activeTab.path], draft: v } }))}
                      onSave={() => save(activeTab.path)}
                    />
                  </div>
                </div>
              ) : <Skeleton className="m-3 h-40" />
            ) : detail[activeTab.id] ? (
              <div className="flex h-full flex-col">
                <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border-subtle px-3 text-2xs text-text-faint">
                  <span className="mono truncate">{detail[activeTab.id].path}</span>
                  <span>base r{detail[activeTab.id].baseRev} → proposed</span>
                  <ChangeStatus status={detail[activeTab.id].status} />
                  <div className="segmented ml-auto" role="group" aria-label="Diff layout">
                    <button data-active={diffMode === "inline"} onClick={() => setDiffMode("inline")}><Rows2 className="inline h-3 w-3" /> inline</button>
                    <button data-active={diffMode === "split"} onClick={() => setDiffMode("split")}><Columns2 className="inline h-3 w-3" /> side by side</button>
                  </div>
                </div>
                <div className="min-h-0 flex-1"><DiffEditor path={detail[activeTab.id].path} before={detail[activeTab.id].before} after={detail[activeTab.id].after} mode={diffMode} /></div>
              </div>
            ) : <Skeleton className="m-3 h-40" />}
          </div>

          {/* Checks */}
          {bottom && (
            <ChecksPanel base={base} runs={runs ?? []} selected={selectedRun} onSelect={setSelectedRun} onCancel={cancelRun} preview={project.preview} />
          )}
        </section>

        {/* Right panel */}
        {right && (
          <aside className="hidden w-[380px] shrink-0 flex-col border-l border-border lg:flex" aria-label="Side panel">
            <div className="tabs h-8 shrink-0 gap-3 px-3" role="tablist">
              {(["changes", "review", "activity"] as const).map((k) => (
                <button key={k} role="tab" data-active={right === k} aria-selected={right === k} onClick={() => setRight(k)} className="tab text-xs">
                  {k === "changes" ? <GitPullRequest className="h-3 w-3" /> : k === "review" ? <FlaskConical className="h-3 w-3" /> : <Activity className="h-3 w-3" />}
                  {k}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {right === "changes" && (
                !changes ? <Skeleton className="m-3 h-24" /> : changes.length === 0 ? (
                  <p className="p-3 text-xs text-text-muted">No agent changes yet. Start the sample mission; its engineer's patch appears here for review once proposed.</p>
                ) : (
                  <ul className="divide-y divide-border-subtle" data-testid="changes-list">
                    {changes.map((c) => (
                      <li key={c.id}>
                        <button onClick={() => openChange(c.id)} className="block w-full px-3 py-2 text-left hover:bg-bg-hover" data-change={c.status}>
                          <span className="mono block truncate text-xs text-text">{c.path}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-text-faint"><ChangeStatus status={c.status} /><span className="mono">{c.author}{c.taskKey ? ` · ${c.taskKey}` : ""}</span><span className="text-success">+{c.added}</span><span className="text-danger">−{c.removed}</span><span className="ml-auto">{timeAgo(c.createdAt)}</span></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              )}
              {right === "review" && (activeChange ? <ReviewPanel companyId={id} c={activeChange} busy={busy} onAction={(a, extra) => changeAction(activeChange.id, a, extra)} onRunCheck={() => runCheck("unit-tests", activeChange.id)} /> : <p className="p-3 text-xs text-text-muted">Select a change to review it.</p>)}
              {right === "activity" && (
                !activity ? <Skeleton className="m-3 h-24" /> : activity.length === 0 ? <p className="p-3 text-xs text-text-muted">No recorded agent or verification activity for this project yet.</p> : (
                  <ol className="divide-y divide-border-subtle text-xs" data-testid="activity">
                    {activity.map((a) => (
                      <li key={a.id}>
                        <button
                          onClick={() => {
                            if (!a.open) return;
                            if (a.open.type === "change") openChange(a.open.id);
                            else if (a.open.type === "file" && a.open.path) openFile(a.open.path);
                            else if (a.open.type === "check") { setBottom(true); setSelectedRun(a.open.id); }
                            else router.push(`/app/${id}/missions/${a.open.id}`);
                          }}
                          className="flex w-full gap-2 px-3 py-1.5 text-left hover:bg-bg-hover"
                        >
                          <span className="mono w-12 shrink-0 text-2xs text-text-faint">{timeAgo(a.at)}</span>
                          <span className="min-w-0 flex-1"><span className="mono text-text-faint">{a.actor}</span> <span className="text-text">{a.text}</span></span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function ChecksPanel({ base, runs, selected, onSelect, onCancel, preview }: { base: string; runs: CheckRun[]; selected: string | null; onSelect: (id: string | null) => void; onCancel: (id: string) => void; preview: { available: boolean; reason: string } }) {
  const [tab, setTab] = useState<"checks" | "preview">("checks");
  const sel = selected ?? runs[0]?.id ?? null;
  const { data: fetched } = useQuery<CheckRun>(sel ? `${base}/checks/${sel}` : null, runs.find((r) => r.id === sel)?.status === "RUNNING" ? 1500 : undefined);
  // Never show a previous run's result while the selected one loads.
  const run = fetched && fetched.id === sel ? fetched : null;
  return (
    <div className="flex h-64 shrink-0 flex-col border-t border-border" aria-label="Checks" data-testid="checks-panel">
      <div className="tabs h-8 shrink-0 gap-3 px-3">
        <button className="tab text-xs" data-active={tab === "checks"} onClick={() => setTab("checks")}>checks</button>
        <button className="tab text-xs" data-active={tab === "preview"} onClick={() => setTab("preview")}><MonitorPlay className="h-3 w-3" /> preview</button>
      </div>
      {tab === "preview" ? (
        <div className="p-3 text-xs text-text-muted" data-testid="preview-unavailable">
          <p className="font-medium text-text">Application preview is not available.</p>
          <p className="mt-1 max-w-2xl">{preview.reason} Rendering project HTML inside AURA's own origin would give it AURA's session, so it is deliberately not done. Use the checks to verify behaviour.</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul className="w-72 shrink-0 overflow-y-auto border-r border-border-subtle text-xs" data-testid="checks-list">
            {runs.length === 0 ? <li className="p-3 text-text-muted">No checks run yet.</li> : runs.map((r) => (
              <li key={r.id}>
                <button onClick={() => onSelect(r.id)} className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-bg-hover", sel === r.id && "bg-bg-raised")} data-run-status={r.status}>
                  <span className={cn("dot", r.status === "PASSED" ? "bg-success" : r.status === "RUNNING" ? "animate-live-dot bg-brand" : r.status === "UNSUPPORTED" || r.status === "CANCELLED" ? "bg-text-faint" : "bg-danger")} />
                  <span className="mono">{r.check}</span>
                  <span className="text-text-faint">{r.status.toLowerCase()}{r.total !== null ? ` ${r.passed}/${r.total}` : ""}</span>
                  <span className="mono ml-auto text-2xs text-text-faint">r{r.revision}{r.changeId ? "+Δ" : ""}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0 flex-1 overflow-y-auto p-3 text-xs">
            {!run ? <p className="text-text-muted">Select a run.</p> : (
              <>
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="mono text-text" data-testid="run-status">{run.status}</span>
                  <span className="mono text-text-faint">exit {run.exitCode ?? "—"}</span>
                  <span className="mono text-text-faint">{run.mode || "—"}</span>
                  <span className="mono text-text-faint">r{run.revision}{run.changeId ? " + proposed change" : ""}</span>
                  <span className="text-text-faint">{run.startedAt ? `started ${timeAgo(run.startedAt)}` : ""}{run.completedAt && run.startedAt ? ` · ${((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(1)}s` : ""}</span>
                  {run.status === "RUNNING" && <button onClick={() => onCancel(run.id)} className="btn-ghost btn-sm h-5"><Square className="h-3 w-3" /> Cancel</button>}
                </div>
                {run.command && <p className="mono mb-1 text-2xs text-text-faint">$ {run.command}</p>}
                {JSON.parse(run.failedNames || "[]").length > 0 && <p className="mb-1 text-danger">Failed: {JSON.parse(run.failedNames).join("; ")}</p>}
                <pre className="well mono whitespace-pre-wrap p-2 text-2xs text-text-muted" data-testid="run-output">{run.output || "(no output)"}</pre>
                {run.truncated && <p className="mt-1 text-2xs text-warning">Output was truncated to the size limit.</p>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


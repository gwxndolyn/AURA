"use client";

/**
 * Delivery panels: deployment targets (connection verified by the provider),
 * preflight, deploy / rollback requests, deployment history with health
 * evidence and logs, follow-up change requests, and the delivery scorecard.
 * Everything comes from /api/companies/[id]/products/[productId]/{deploy,changes,gate}.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, XCircle, AlertTriangle, Rocket, RotateCcw, ExternalLink } from "lucide-react";
import { useQuery, fetchJSON } from "@/hooks/useApi";
import { Skeleton, Badge } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { timeAgo } from "@/lib/utils";

interface Check { id: string; label: string; status: string; detail: string }
interface Target { id: string; env: string; provider: string; status: string; statusDetail: string; verifiedAt: string | null; config: { port?: number; healthPath?: string; journeys?: { path: string; expectStatus?: number; expectText?: string }[] }; secretEnvNames: string[]; secretsPresent: Record<string, boolean>; autoDeploy: boolean }
interface Deployment { id: string; env: string; provider: string; ref: string; sha: string; releaseVersion: number | null; status: string; url: string | null; health: { path: string; ok: boolean; status: number | null; ms: number; detail: string }[]; logs: string; failure: string; rolledBackTo: string | null; requestedBy: string; createdAt: string; finishedAt: string | null; preflight: Check[] }
interface DeployData { providers: { id: string; label: string; supportsRollback: boolean }[]; targets: Target[]; preflight: Record<string, Check[] | null>; history: Deployment[] }
interface Metric { value: number | null; numerator: number; denominator: number; unit: string; formula: string; unavailable?: string }

const ICON: Record<string, React.ReactNode> = { passed: <CheckCircle2 className="h-3.5 w-3.5 text-success" />, failed: <XCircle className="h-3.5 w-3.5 text-danger" />, warning: <AlertTriangle className="h-3.5 w-3.5 text-warning" />, not_applicable: <CircleDashed className="h-3.5 w-3.5 text-text-faint" /> };
const TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = { VERIFIED: "success", SUPERSEDED: "neutral", ROLLED_BACK: "warning", FAILED: "danger", CANCELLED: "neutral", PREFLIGHT: "warning", QUEUED: "info", BUILDING: "info", STARTING: "info", VERIFYING: "info", CONNECTED: "success", ERROR: "danger", UNVERIFIED: "neutral" };

export function DeliveryTab({ base, canAct, isAdmin, version }: { base: string; canAct: boolean; isAdmin: boolean; version: number }) {
  const { toast } = useApp();
  const { data, error, refetch } = useQuery<DeployData>(`${base}/deploy`, 5000);
  const [env, setEnv] = useState<"preview" | "production">("production");
  const [form, setForm] = useState({ port: 3100, healthPath: "/api/health", journeys: "/ \n/api/health", secrets: "", autoDeploy: false });
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { if (version > 0) refetch(); }, [version, refetch]);
  async function post(label: string, body: unknown) {
    try {
      await fetchJSON(`${base}/deploy`, { method: "POST", body: JSON.stringify(body) });
      toast({ title: label, level: "success" });
      refetch();
    } catch (e) {
      toast({ title: `${label} failed`, description: (e as Error).message, level: "danger" });
    }
  }
  // Prefill the form from the saved target so "save" never silently changes a live configuration.
  const saved = data?.targets.find((t) => t.env === env);
  useEffect(() => {
    if (saved) setForm({ port: saved.config.port ?? 3000, healthPath: saved.config.healthPath ?? "/api/health", journeys: (saved.config.journeys ?? []).map((j) => (j.expectText ? `${j.path} | ${j.expectText}` : j.path)).join("\n") || "/", secrets: saved.secretEnvNames.join(", "), autoDeploy: saved.autoDeploy });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.id, env]);
  if (error) return <p className="text-sm text-danger">Could not load deployments: {error}</p>;
  if (!data) return <Skeleton className="h-60" />;
  const target = data.targets.find((t) => t.env === env);
  const pre = data.preflight[env];
  const live = data.history.find((d) => d.env === env && d.status === "VERIFIED");
  const preOk = !!pre && pre.every((c) => c.status !== "failed");
  return (
    <div className="space-y-5" data-testid="delivery">
      <div className="segmented text-xs">{(["preview", "production"] as const).map((e) => <button key={e} data-active={env === e} onClick={() => setEnv(e)}>{e}</button>)}</div>
      <section className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-border p-3" data-testid="live" data-live={!!live}>
          <div className="metric-label">Live on {env}</div>
          {live ? <><div className="mt-1 flex items-center gap-2 text-sm font-medium"><a className="underline" href={live.url ?? "#"} target="_blank" rel="noreferrer">{live.url} <ExternalLink className="inline h-3 w-3" /></a></div><p className="mono text-2xs text-text-faint">{live.sha.slice(0, 8)} · RC {live.releaseVersion} · verified {timeAgo(live.finishedAt ?? live.createdAt)} · {live.health.filter((h) => h.ok).length}/{live.health.length} checks</p></> : <p className="mt-1 text-xs text-text-muted">Nothing is deployed to {env}.</p>}
        </div>
        <div className="rounded-lg border border-border p-3" data-testid="target" data-status={target?.status ?? "NONE"}>
          <div className="metric-label">Target</div>
          {target ? <><div className="mt-1 flex items-center gap-2 text-sm"><Badge tone={TONE[target.status]}>{target.status.toLowerCase()}</Badge> {target.provider}</div><p className="text-2xs text-text-faint">{target.statusDetail}{target.verifiedAt ? ` · checked ${timeAgo(target.verifiedAt)}` : ""}</p>{target.secretEnvNames.length > 0 && <p className="mono text-2xs">{target.secretEnvNames.map((n) => `${n}${target.secretsPresent[n] ? " ✓" : " missing"}`).join(" · ")}</p>}</> : <p className="mt-1 text-xs text-text-muted">No {env} target. {isAdmin ? "Configure one below." : "An admin must configure one."}</p>}
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="metric-label">Release policy</div>
          <p className="mt-1 text-xs">{env === "production" ? "Every production deployment needs an admin's approval. On failed post-deploy checks AURA restores the previous version." : target?.autoDeploy ? "Preview deploys automatically when the product autonomy is Bounded or Continuous." : "Preview deploys need an admin's approval."}</p>
        </div>
      </section>

      {pre && (
        <section>
          <h3 className="mb-1 text-sm font-medium">Preflight ({env})</h3>
          <ul className="divide-y divide-border-subtle rounded-lg border border-border text-xs" data-testid="preflight">{pre.map((c) => <li key={c.id} className="flex items-start gap-2 px-3 py-1.5" data-check={c.id} data-status={c.status}>{ICON[c.status] ?? ICON.not_applicable}<span className="w-64 shrink-0">{c.label}</span><span className="text-text-muted">{c.detail}</span></li>)}</ul>
          {canAct && <div className="mt-2 flex gap-2">
            <button className="btn-primary btn-sm" data-testid="request-deploy" disabled={!preOk} title={preOk ? "" : "Fix the failed preflight checks first"} onClick={() => post(`Deployment to ${env} requested`, { action: "deploy", env })}><Rocket className="h-3 w-3" /> Deploy to {env}</button>
            {live && <button className="btn-ghost btn-sm" onClick={() => post("Rollback requested", { action: "rollback", env })}><RotateCcw className="h-3 w-3" /> Roll back</button>}
          </div>}
        </section>
      )}

      {isAdmin && (
        <section className="rounded-lg border border-border p-3 text-xs">
          <h3 className="mb-2 text-sm font-medium">{target ? "Update" : "Configure"} {env} target</h3>
          <div className="grid gap-2 md:grid-cols-[180px_100px_160px_minmax(0,1fr)_minmax(0,1fr)]">
            <select className="input h-8" aria-label="Provider" value="docker-host" onChange={() => {}}>{data.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
            <input className="input h-8" type="number" aria-label="Port" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
            <input className="input h-8" aria-label="Health path" value={form.healthPath} onChange={(e) => setForm({ ...form, healthPath: e.target.value })} />
            <textarea className="input h-16" aria-label="Journey checks (one path per line, optional: path | expected text)" value={form.journeys} onChange={(e) => setForm({ ...form, journeys: e.target.value })} />
            <input className="input h-8" aria-label="Secret env var names (comma separated)" placeholder="SECRET_NAMES (values stay on the server)" value={form.secrets} onChange={(e) => setForm({ ...form, secrets: e.target.value })} />
          </div>
          {env === "preview" && <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={form.autoDeploy} onChange={(e) => setForm({ ...form, autoDeploy: e.target.checked })} /> Deploy approved releases to preview automatically (Bounded/Continuous autonomy only)</label>}
          <button className="btn-secondary btn-sm mt-2" data-testid="save-target" onClick={() => post("Target saved and connection checked", { action: "target", env, provider: "docker-host", config: { port: form.port, healthPath: form.healthPath, journeys: form.journeys.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [path, text] = l.split("|").map((x) => x.trim()); return { path, ...(text ? { expectText: text } : {}) }; }) }, secretEnvNames: form.secrets.split(",").map((s) => s.trim()).filter(Boolean), autoDeploy: env === "preview" && form.autoDeploy })}>Save & verify connection</button>
          <p className="mt-1 text-2xs text-text-faint">Docker host: runs the release as a hardened container on the Docker daemon the AURA worker can reach (local socket or DOCKER_HOST). Managed cloud providers are not integrated yet.</p>
        </section>
      )}

      <section>
        <h3 className="mb-1 text-sm font-medium">Deployment history</h3>
        {!data.history.length ? <p className="text-xs text-text-muted">No deployments yet.</p> : (
          <ul className="space-y-1 text-xs" data-testid="deployments">{data.history.map((d) => (
            <li key={d.id} className="rounded border border-border px-3 py-2" data-deployment={d.id} data-status={d.status}>
              <button className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(open === d.id ? null : d.id)}><Badge tone={TONE[d.status] ?? "neutral"}>{d.status.toLowerCase().replace("_", " ")}</Badge><span className="mono">{d.env} · {d.sha.slice(0, 8)}</span><span className="text-text-faint">{d.provider} · by {d.requestedBy} · {timeAgo(d.createdAt)}</span>{d.url && <span className="mono text-text-faint">{d.url}</span>}</button>
              {d.failure && <p className="mt-1 text-danger">{d.failure.slice(0, 400)}</p>}
              {open === d.id && <div className="mt-2 space-y-1">
                {d.health.length > 0 && <ul>{d.health.map((h, i) => <li key={i} className="flex gap-2">{h.ok ? ICON.passed : ICON.failed}<span className="mono">{h.path}</span><span className="text-text-muted">{h.detail} · {h.ms} ms</span></li>)}</ul>}
                <pre className="mono max-h-64 overflow-auto rounded bg-bg-inset p-2 text-2xs">{d.logs || "no log yet"}</pre>
              </div>}
            </li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}

export function ChangesTab({ base, canAct, version }: { base: string; canAct: boolean; version: number }) {
  const { toast } = useApp();
  const { data, refetch } = useQuery<{ id: string; version: number; status: string; createdAt: string; content: { request: string; status: string; story?: string; plan?: { summary: string; tasks: { title: string; files: string[] }[]; preserves: string[] }; base?: { branch: string; sha: string } } }[]>(`${base}/changes`, 5000);
  const [text, setText] = useState("");
  useEffect(() => { if (version > 0) refetch(); }, [version, refetch]);
  async function submit() {
    try {
      await fetchJSON(`${base}/changes`, { method: "POST", body: JSON.stringify({ request: text }) });
      setText("");
      toast({ title: "Change requested — the product manager is planning it", level: "success" });
      refetch();
    } catch (e) {
      toast({ title: "Request failed", description: (e as Error).message, level: "danger" });
    }
  }
  return (
    <div className="space-y-4" data-testid="changes">
      {canAct && <div className="flex gap-2"><input className="input h-9 flex-1" aria-label="Describe a change" placeholder="e.g. Add an endpoint to fetch one assessment; fix the mobile layout of the results page" value={text} onChange={(e) => setText(e.target.value)} /><button className="btn-primary btn-sm" disabled={text.trim().length < 10} onClick={submit} data-testid="submit-change">Request change</button></div>}
      <p className="text-2xs text-text-faint">AURA inspects the current code and deployment, plans the smallest set of tasks on the existing files, builds on the latest approved release, and re-runs all existing tests before anything is released.</p>
      {!data ? <Skeleton className="h-20" /> : !data.length ? <p className="text-xs text-text-muted">No change requests yet.</p> : (
        <ul className="space-y-2 text-xs">{data.map((c) => (
          <li key={c.id} className="rounded-lg border border-border p-3" data-change={c.content.story ?? c.id} data-status={c.content.status}>
            <div className="flex items-center gap-2"><Badge tone={c.content.status === "PLANNED" ? "success" : "info"}>{c.content.status.toLowerCase()}</Badge><span className="font-medium">{c.content.request.slice(0, 200)}</span><span className="ml-auto text-text-faint">{timeAgo(c.createdAt)}</span></div>
            {c.content.plan && <div className="mt-1 text-text-muted"><p>{c.content.story}: {c.content.plan.summary} (on {c.content.base?.branch} @ {c.content.base?.sha.slice(0, 8)})</p><ul className="ml-4 list-disc">{c.content.plan.tasks.map((t, i) => <li key={i}>{t.title} <span className="mono text-text-faint">{t.files.join(", ")}</span></li>)}</ul>{c.content.plan.preserves.length > 0 && <p>Must keep working: {c.content.plan.preserves.join("; ")}</p>}</div>}
          </li>
        ))}</ul>
      )}
    </div>
  );
}

export function ScorecardPanel({ metrics }: { metrics: Record<string, Metric> | undefined }) {
  if (!metrics) return null;
  const fmt = (k: string, m: Metric) => (m.value == null ? "unavailable" : m.unit === "ratio" ? `${Math.round(m.value * 100)}%` : m.unit.startsWith("usd") ? `$${m.value.toFixed(4)} est.` : m.unit === "minutes" ? `${m.value.toFixed(1)} min` : String(m.value));
  return (
    <section data-testid="delivery-scorecard">
      <h3 className="mb-1 text-sm font-medium">Delivery scorecard</h3>
      <div className="grid gap-2 text-xs md:grid-cols-5">{Object.entries(metrics).map(([k, m]) => <div key={k} className="rounded border border-border p-2" title={m.formula} data-metric={k}><div className="metric-label">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</div><div className="mono mt-0.5">{fmt(k, m)}</div><div className="text-2xs text-text-faint">{m.unavailable ?? (m.unit === "ratio" ? `${Number(m.numerator.toFixed(2))}/${m.denominator}` : "")}</div></div>)}</div>
    </section>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, Loader2, Lock, ShieldAlert, X } from "lucide-react";
import { useQuery, useMutation } from "@/hooks/useApi";
import { Badge, ErrorState, Skeleton } from "@/components/ui/primitives";
import { ActionFacts } from "@/components/ui/term";
import { useApp } from "@/lib/store";
import { cn, timeAgo } from "@/lib/utils";
import { CertaintyBadge, SeverityBadge } from "./badges";

interface Evidence {
  kind: string;
  id: string;
  label: string;
  detail?: string;
  exists: boolean | null;
  href: string | null;
  log?: { status: string; errorCategory: string | null; error: string; tools: { tool: string; status: string; durationMs: number; error?: string }[] };
}
interface Rec {
  action: string;
  label: string;
  reason: string;
  expectedOutcome: string;
  risks: string;
  cost: string;
  requiresApproval: boolean;
  reversible: boolean;
  unavailable: string | null;
  policy: { decision: "allowed" | "blocked" | "requires_approval"; rule: string; detail: string };
}
interface Detail {
  id: string;
  ruleId: string;
  ruleVersion: number;
  title: string;
  explanation: string;
  severity: string;
  severityReason: string;
  certainty: string;
  status: string;
  resourceType: string;
  resourceLabel: string;
  missionId: string | null;
  requiresHuman: boolean;
  nextAction: string;
  occurrences: number;
  firstDetectedAt: string;
  lastObservedAt: string;
  acknowledgedBy: string | null;
  resolvedBy: string | null;
  resolution: string;
  evidence: Evidence[];
  facts: Record<string, unknown>;
  history: { at: string; actor: string; change: string; detail?: string }[];
  rule: { id: string; version: number; title: string; definition: Record<string, string>; currentVersion: number | null } | null;
  recommendations: Rec[];
  actions: { id: string; actionType: string; initiatedBy: string; trigger: string; policyLevel: string; policyRule: string; decision: string; status: string; result: Record<string, unknown>; error: string; createdAt: string }[];
  policyLevel: string;
}

const NEXT_STATUS: Record<string, { to: string; label: string }[]> = {
  OPEN: [{ to: "ACKNOWLEDGED", label: "Acknowledge" }, { to: "INVESTIGATING", label: "Investigating" }, { to: "DISMISSED", label: "Dismiss" }],
  ACKNOWLEDGED: [{ to: "INVESTIGATING", label: "Investigating" }, { to: "DISMISSED", label: "Dismiss" }],
  INVESTIGATING: [{ to: "ACKNOWLEDGED", label: "Back to acknowledged" }, { to: "DISMISSED", label: "Dismiss" }],
  RESOLVED: [{ to: "OPEN", label: "Re-open" }],
  DISMISSED: [{ to: "OPEN", label: "Re-open" }],
};

/**
 * Finding inspector: evidence first (with links to the actual rows), then the
 * rule that fired and why, then recommendations with the policy decision for
 * THIS user, then the lifecycle + action history.
 */
export function FindingInspector({ companyId, findingId, version, onClose, onChanged }: { companyId: string; findingId: string; version: number; onClose: () => void; onChanged: () => void }) {
  const url = `/api/companies/${companyId}/ops/findings/${findingId}`;
  const { data: f, error, refetch } = useQuery<Detail>(url, 15000);
  // Re-read whenever the page refreshes (evaluation run, live event).
  useEffect(() => {
    if (version > 0) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const act = useMutation<{ action: string }, { status: string; error: string; result: { service?: unknown; policy?: string }; policy: Rec["policy"] }>();
  const { toast } = useApp();
  const [running, setRunning] = useState<string | null>(null);
  const [showRule, setShowRule] = useState(false);

  async function setStatus(status: string) {
    try {
      await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) }).then(async (r) => {
        const j = await r.json();
        if (!j.ok) throw new Error(j.error);
      });
      refetch();
      onChanged();
    } catch (e) {
      toast({ title: "Couldn't update the finding", description: (e as Error).message, level: "danger" });
    }
  }

  async function run(action: string) {
    setRunning(action);
    try {
      const r = await act.mutate(`${url}/actions`, { action });
      toast({ title: r.status === "succeeded" ? "Action completed" : r.status === "failed" ? "Action failed" : "Action blocked by policy", description: r.status === "failed" ? r.error : r.status === "blocked" ? r.policy.detail : undefined, level: r.status === "succeeded" ? "success" : r.status === "failed" ? "danger" : "warning" });
    } catch (e) {
      toast({ title: "Action not run", description: (e as Error).message, level: "warning" });
    } finally {
      setRunning(null);
      refetch();
      onChanged();
    }
  }

  return (
    <aside className="flex h-full min-h-0 flex-col rounded-lg border border-border" aria-label="Finding detail" data-testid="finding-inspector">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="mono text-2xs text-text-faint">{f?.ruleId ?? "…"}{f ? ` v${f.ruleVersion}` : ""}</span>
        <button onClick={onClose} className="icon-btn" aria-label="Close"><X className="h-3.5 w-3.5" /></button>
      </div>
      {error && !f ? (
        <div className="p-3"><ErrorState message={error} onRetry={refetch} /></div>
      ) : !f ? (
        <div className="space-y-2 p-3"><Skeleton className="h-6" /><Skeleton className="h-24" /><Skeleton className="h-32" /></div>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-sm">
          <header>
            <div className="flex flex-wrap items-center gap-1.5">
              <SeverityBadge severity={f.severity} />
              <CertaintyBadge certainty={f.certainty} />
              <Badge>{f.status.toLowerCase()}</Badge>
              {f.requiresHuman && <Badge tone="warning">needs a person</Badge>}
            </div>
            <h2 className="mt-2 text-base font-semibold leading-snug text-text">{f.title}</h2>
            <p className="mt-1 text-text-muted">{f.explanation}</p>
            <p className="mono mt-1 text-2xs text-text-faint">
              {f.resourceType} · {f.resourceLabel} · first {timeAgo(f.firstDetectedAt)} · last {timeAgo(f.lastObservedAt)} · seen {f.occurrences}×
            </p>
            <p className="mt-1 text-xs text-text-muted"><span className="metric-label mr-1">Severity because</span>{f.severityReason}</p>
          </header>

          <section>
            <h3 className="metric-label mb-1">Evidence (system-recorded)</h3>
            <ul className="divide-y divide-border-subtle rounded-md border border-border" data-testid="finding-evidence">
              {f.evidence.map((e) => (
                <li key={`${e.kind}:${e.id}`} className="px-2.5 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="mono w-16 shrink-0 text-text-faint">{e.kind}</span>
                    <span className="min-w-0 flex-1 truncate text-text">{e.label}</span>
                    {e.exists === false && <span className="text-danger">no longer exists</span>}
                    {e.href && (
                      <Link href={`/app/${companyId}${e.href}`} className="inline-flex items-center gap-0.5 text-text-muted hover:text-text">open <ArrowUpRight className="h-3 w-3" /></Link>
                    )}
                  </div>
                  {e.detail && <div className="mono mt-0.5 pl-[72px] text-2xs text-text-muted">{e.detail}</div>}
                  {e.log && (
                    <div className="mt-1 pl-[72px]">
                      {e.log.error && <div className="mono text-2xs text-danger">{e.log.errorCategory}: {e.log.error}</div>}
                      {e.log.tools.length > 0 && (
                        <ul className="mono mt-0.5 space-y-0.5 text-2xs text-text-faint">
                          {e.log.tools.map((t, i) => <li key={i}>{t.status.padEnd(8)} {t.tool} {t.durationMs}ms{t.error ? ` — ${t.error.slice(0, 120)}` : ""}</li>)}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {Object.keys(f.facts).length > 0 && (
              <dl className="mono mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-2xs text-text-muted">
                {Object.entries(f.facts).map(([k, v]) => (
                  <div key={k} className="flex gap-1.5"><dt className="text-text-faint">{k}</dt><dd className="truncate text-text">{typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(4)) : String(v)}</dd></div>
                ))}
              </dl>
            )}
          </section>

          {f.rule && (
            <section>
              <button onClick={() => setShowRule((v) => !v)} className="metric-label hover:text-text-muted" aria-expanded={showRule}>Rule {showRule ? "▾" : "▸"} {f.rule.title}</button>
              {showRule && (
                <dl className="mt-1 space-y-1 rounded-md border border-border-subtle bg-bg-inset p-2.5 text-xs">
                  {Object.entries(f.rule.definition).map(([k, v]) => (
                    <div key={k}><dt className="metric-label">{k.replace(/([A-Z])/g, " $1")}</dt><dd className="text-text-muted">{v}</dd></div>
                  ))}
                  {f.rule.currentVersion && <p className="text-warning">Evaluated with v{f.ruleVersion}; current rule is v{f.rule.currentVersion}.</p>}
                </dl>
              )}
            </section>
          )}

          <section>
            <h3 className="metric-label mb-1">Recommended next steps <span className="normal-case tracking-normal text-text-faint">· policy {f.policyLevel.toLowerCase()}</span></h3>
            {f.recommendations.length === 0 ? (
              <p className="text-xs text-text-muted">{f.nextAction || "No automated action applies; follow the evidence links."}</p>
            ) : (
              <ul className="space-y-2" data-testid="recommendations">
                {f.recommendations.map((r) => {
                  const runnable = !r.unavailable && r.policy.decision === "allowed";
                  return (
                    <li key={r.action} className="rounded-md border border-border p-2.5" data-action={r.action} data-decision={r.unavailable ? "unavailable" : r.policy.decision}>
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-text">{r.label}</div>
                          <p className="text-xs text-text-muted">{r.reason}</p>
                        </div>
                        {runnable ? (
                          <button onClick={() => run(r.action)} disabled={!!running} className="btn-secondary btn-sm shrink-0">
                            {running === r.action ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />} Run
                          </button>
                        ) : (
                          <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-text-faint"><Lock className="h-3 w-3" />{r.unavailable ? "unavailable" : r.policy.decision === "requires_approval" ? "needs approval" : "blocked"}</span>
                        )}
                      </div>
                      <dl className="mt-1.5 grid gap-x-3 gap-y-0.5 text-2xs sm:grid-cols-2">
                        <div><dt className="inline text-text-faint">Expected: </dt><dd className="inline text-text-muted">{r.expectedOutcome}</dd></div>
                        <div><dt className="inline text-text-faint">Risk: </dt><dd className="inline text-text-muted">{r.risks}</dd></div>
                        <div><dt className="inline text-text-faint">Cost: </dt><dd className="inline text-text-muted">{r.cost}</dd></div>
                        <div><ActionFacts reversible={r.reversible} approval={r.requiresApproval} /></div>
                      </dl>
                      {(r.unavailable || r.policy.decision !== "allowed") && (
                        <p className="mt-1.5 flex gap-1 text-2xs text-warning" data-testid="policy-reason"><ShieldAlert className="mt-px h-3 w-3 shrink-0" />{r.unavailable ?? `${r.policy.detail} (${r.policy.rule})`}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h3 className="metric-label mb-1">Lifecycle</h3>
            <div className="flex flex-wrap gap-1.5">
              {(NEXT_STATUS[f.status] ?? []).map((s) => (
                <button key={s.to} onClick={() => setStatus(s.to)} className="btn-ghost btn-sm">{s.label}</button>
              ))}
            </div>
            {f.resolvedBy && <p className="mt-1 text-xs text-text-muted">Resolved by {f.resolvedBy === "rule" ? "the rule (criteria met)" : f.resolvedBy}: {f.resolution}</p>}
          </section>

          <section>
            <h3 className="metric-label mb-1">History &amp; actions</h3>
            <ol className="space-y-1 text-xs" data-testid="finding-history">
              {[...f.history.map((h) => ({ at: h.at, who: h.actor, what: h.change, detail: h.detail })), ...f.actions.map((a) => ({ at: a.createdAt, who: `${a.initiatedBy}${a.trigger === "automatic" ? " (auto)" : ""}`, what: `${a.actionType}: ${a.decision === "allowed" ? a.status : a.decision}`, detail: `${a.policyRule} @ ${a.policyLevel.toLowerCase()}${a.error ? ` — ${a.error}` : ""}` }))]
                .sort((a, b) => a.at.localeCompare(b.at))
                .map((h, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mono w-14 shrink-0 text-2xs text-text-faint">{timeAgo(h.at)}</span>
                    <span className="min-w-0 flex-1"><span className="text-text">{h.what}</span> <span className="text-text-faint">· {h.who}</span>{h.detail && <span className={cn("block text-2xs", /failed|blocked/.test(h.what) ? "text-warning" : "text-text-muted")}>{h.detail}</span>}</span>
                  </li>
                ))}
            </ol>
          </section>
        </div>
      )}
    </aside>
  );
}

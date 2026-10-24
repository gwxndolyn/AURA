"use client";

import { useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle, Circle, X, User, Cpu } from "lucide-react";
import { useQuery } from "@/hooks/useApi";
import { Badge, Skeleton, Section } from "@/components/ui/primitives";
import { Term } from "@/components/ui/term";
import { cn, timeAgo } from "@/lib/utils";

interface Entry {
  id: string;
  at: string;
  actor: string;
  action: string;
  taskKey: string | null;
  result: "success" | "failure" | "warning" | "info";
  summary: string;
  facts: string[];
  claim: string;
  refs: { kind: string; id: string; label: string }[];
  usage?: { modelCalls: number; toolCalls: number; tokensIn: number; tokensOut: number; costUsd: number; estimated: boolean; latencyMs: number; model: string; mode: string; retries: number };
}

interface Finding {
  code: string;
  source: string;
  severity: string;
  blocking: boolean;
  title: string;
  status: string;
  supported: boolean;
}

const ICON = {
  success: { Icon: CheckCircle2, cls: "text-success" },
  failure: { Icon: XCircle, cls: "text-danger" },
  warning: { Icon: AlertTriangle, cls: "text-warning" },
  info: { Icon: Circle, cls: "text-text-faint" },
};

function Actor({ actor }: { actor: string }) {
  if (actor.startsWith("human:")) return <span className="inline-flex items-center gap-1 text-text"><User className="h-3 w-3" />{actor.slice(6)}</span>;
  if (actor === "system") return <span className="inline-flex items-center gap-1 text-text-muted"><Cpu className="h-3 w-3" />system</span>;
  return <span className="mono text-text">{actor}</span>;
}

/**
 * Agent collaboration timeline. Every row is a persisted event (task run,
 * finding, handoff, approval, plan decision). "Verified" lines come from tool
 * results recorded by the system; "Agent said" is the agent's own claim.
 */
export function CollaborationTimeline({ companyId, missionId, version }: { companyId: string; missionId: string; version: string }) {
  const base = `/api/companies/${companyId}/missions/${missionId}`;
  const { data: entries } = useQuery<Entry[]>(`${base}/timeline?v=${version}`);
  const [open, setOpen] = useState<{ kind: string; id: string } | null>(null);

  if (!entries) return <Skeleton className="h-64" />;
  if (!entries.length) return <p className="text-sm text-text-muted">Nothing has happened yet. Events appear here as the plan is proposed and agents execute tasks.</p>;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
      <ol className="relative space-y-0 border-l border-border pl-4" aria-label="Collaboration timeline" data-testid="collab-timeline">
        {entries.map((e) => {
          const { Icon, cls } = ICON[e.result];
          return (
            <li key={e.id} className="relative pb-4" data-entry={e.id.split("-")[0]} data-result={e.result}>
              <Icon className={cn("absolute -left-[23px] top-0.5 h-3.5 w-3.5 bg-bg", cls)} />
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <Actor actor={e.actor} />
                <span className="text-text-muted">{e.action}</span>
                {e.taskKey && <span className="mono text-2xs text-text-faint">{e.taskKey}</span>}
                <span className="mono ml-auto text-2xs text-text-faint" title={e.at}>{timeAgo(e.at)}</span>
              </div>
              {e.summary && <div className="mt-0.5 text-xs text-text-muted">{e.summary}</div>}
              {e.facts.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {e.facts.map((f, i) => (
                    <li key={i} className="flex gap-1.5 text-xs text-text"><span className="mono shrink-0 text-2xs text-success">verified</span>{f}</li>
                  ))}
                </ul>
              )}
              {e.claim && (
                <div className="mt-1 flex gap-1.5 text-xs text-text-faint"><span className="mono shrink-0 text-2xs">agent said</span><span className="italic">{e.claim.slice(0, 240)}{e.claim.length > 240 ? "…" : ""}</span></div>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {e.refs.filter((r) => r.kind === "run" || r.kind === "handoff").map((r) => (
                  <button key={r.id} onClick={() => setOpen({ kind: r.kind, id: r.id })} className="mono rounded border border-border px-1.5 py-0.5 text-2xs text-text-muted hover:border-border-strong hover:text-text" aria-pressed={open?.id === r.id}>
                    {r.kind === "run" ? "inspect run" : r.label}
                  </button>
                ))}
                {e.usage && (e.usage.modelCalls > 0 || e.usage.toolCalls > 0) && (
                  <span className="mono text-2xs text-text-faint">
                    {e.usage.modelCalls} model · {e.usage.toolCalls} tool · {e.usage.tokensIn + e.usage.tokensOut} tok{e.usage.estimated ? " (est.)" : ""} · ${e.usage.costUsd.toFixed(4)}{e.usage.estimated ? " est." : ""} · {(e.usage.latencyMs / 1000).toFixed(1)}s{e.usage.retries ? ` · ${e.usage.retries} retry` : ""}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="xl:sticky xl:top-4 xl:self-start">
        {open ? <Inspector key={`${open.kind}:${open.id}`} base={base} target={open} onClose={() => setOpen(null)} /> : <p className="text-sm text-text-muted">Select <span className="mono text-xs">inspect run</span> or a handoff to see the context an agent received, its validated output and its tool calls.</p>}
      </div>
    </div>
  );
}

function Inspector({ base, target, onClose }: { base: string; target: { kind: string; id: string }; onClose: () => void }) {
  const url = target.kind === "run" ? `${base}/runs/${target.id}` : `${base}/handoffs/${target.id}`;
  const { data } = useQuery<any>(url);
  return (
    <aside className="rounded-lg border border-border" aria-label={target.kind === "run" ? "Task run detail" : "Handoff detail"} data-testid="inspector">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-medium">{target.kind === "run" ? "Task run" : "Handoff"}</span>
        <button onClick={onClose} className="icon-btn" aria-label="Close"><X className="h-3.5 w-3.5" /></button>
      </div>
      {!data ? (
        <Skeleton className="m-3 h-40" />
      ) : target.kind === "run" ? (
        <div className="max-h-[70vh] space-y-3 overflow-y-auto p-3 text-xs">
          <div className="flex flex-wrap gap-1.5">
            <Badge>{data.agentKey}</Badge>
            <Badge tone={data.status === "SUCCEEDED" ? "success" : data.status === "FAILED" ? "danger" : "neutral"}>{data.status.toLowerCase()}{data.outcome ? ` · ${data.outcome}` : ""}</Badge>
            <Badge tone={data.outputValid ? "success" : "danger"}>{data.outputValid ? "output valid" : "output invalid"}</Badge>
            {data.mode !== "none" && <Badge>{data.mode === "live" ? data.model : "simulator"}</Badge>}
          </div>
          {data.error && <p className="text-danger">{data.errorCategory}: {data.error}</p>}
          <div>
            <div className="metric-label mb-1"><Term k="artifact">Context received</Term> · {data.contextTokens} tok (est.)</div>
            <ul className="space-y-0.5">
              {data.contextSources.map((s: any) => (
                <li key={s.id} className={cn("mono flex gap-2", !s.included && "text-text-faint line-through")}>
                  <span className="w-20 shrink-0">{s.kind}</span>
                  <span className="min-w-0 flex-1 truncate" title={s.ref}>{s.ref}</span>
                  <span>{s.tokens}</span>
                  {s.required && <span className="text-text-muted">req</span>}
                  {s.truncated && <span className="text-warning">trunc</span>}
                </li>
              ))}
            </ul>
            {data.contextNotes.map((n: string) => <p key={n} className="mt-1 text-warning">{n}</p>)}
          </div>
          <div>
            <div className="metric-label mb-1">Validated output</div>
            <pre className="well mono max-h-64 overflow-auto whitespace-pre-wrap p-2 text-2xs text-text-muted">{JSON.stringify(data.output, null, 2)}</pre>
            {data.validationErrors.length > 0 && <p className="mt-1 text-danger">{data.validationErrors.join("; ")}</p>}
          </div>
          {data.claims && (
            <div>
              <div className="metric-label mb-1">Agent claim (not verified)</div>
              <p className="italic text-text-muted">{data.claims}</p>
            </div>
          )}
          <div>
            <div className="metric-label mb-1"><Term k="tool">Tool calls</Term></div>
            <ul className="space-y-0.5">
              {data.toolCalls.map((c: any, i: number) => (
                <li key={i} className="mono flex gap-2"><span className={c.ok ? "text-success" : "text-danger"}>{c.status}</span><span className="flex-1">{c.tool}</span><span className="text-text-faint">{c.durationMs}ms</span></li>
              ))}
              {data.toolLog.filter((l: any) => l.status === "retrying").map((l: any, i: number) => <li key={`r${i}`} className="mono text-warning">retry: {l.error}</li>)}
            </ul>
          </div>
          <p className="text-2xs text-text-faint">{data.modelCalls === 0 ? "No model call (deterministic step)" : `${data.modelCalls} model call${data.modelCalls === 1 ? "" : "s"} · ${data.tokensIn}/${data.tokensOut} tok in/out ${data.usageEstimated ? "(estimated)" : "(provider-reported)"}`}{data.cacheReadTokens ? ` · ${data.cacheReadTokens} cache-read` : ""} · ${data.costUsd.toFixed(4)}{data.usageEstimated ? " est." : ""} · {data.routingReason}</p>
        </div>
      ) : (
        <div className="max-h-[70vh] space-y-3 overflow-y-auto p-3 text-xs">
          <div className="flex flex-wrap gap-1.5">
            <Badge>{data.fromAgent} → {data.toAgents.join(", ") || "—"}</Badge>
            <Badge tone={data.valid ? "success" : "danger"}>{data.valid ? "validated" : "invalid"}</Badge>
          </div>
          {data.errors.length > 0 && <p className="text-danger">{data.errors.join("; ")}</p>}
          {(["findings", "decisions", "risks"] as const).map((k) => data.payload[k]?.length > 0 && (
            <div key={k}>
              <div className="metric-label mb-1">{k}</div>
              <ul className="list-disc pl-4">{data.payload[k].map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
            </div>
          ))}
          {data.payload.tests?.length > 0 && (
            <div>
              <div className="metric-label mb-1">Tests (system-recorded)</div>
              {data.payload.tests.map((t: any) => <p key={t.artifactId} className="mono">{t.passed}/{t.total} passed · {t.mode}{t.failing.length ? ` · failing: ${t.failing.join("; ")}` : ""}</p>)}
            </div>
          )}
          {data.payload.outstandingIssues?.length > 0 && (
            <div>
              <div className="metric-label mb-1">Outstanding issues</div>
              {data.payload.outstandingIssues.map((i: any) => <p key={i.code}>{i.code} [{i.severity}{i.blocking ? ", blocking" : ""}] {i.title}</p>)}
            </div>
          )}
          <div><div className="metric-label mb-1">Next action</div><p>{data.payload.nextAction}</p></div>
          <details>
            <summary className="cursor-pointer text-text-faint">Raw handoff</summary>
            <pre className="well mono mt-1 max-h-64 overflow-auto whitespace-pre-wrap p-2 text-2xs text-text-muted">{JSON.stringify(data.payload, null, 2)}</pre>
          </details>
        </div>
      )}
    </aside>
  );
}

/** Findings table: severity, evidence status, lifecycle. */
export function FindingsList({ findings }: { findings: Finding[] }) {
  if (!findings.length) return null;
  return (
    <Section title="Findings">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="table min-w-[640px]" data-testid="findings">
          <thead className="bg-bg-raised"><tr><th>Id</th><th>Source</th><th>Severity</th><th>Finding</th><th>Evidence</th><th>Status</th></tr></thead>
          <tbody>
            {findings.map((f) => (
              <tr key={f.code} data-finding={f.status}>
                <td className="mono text-xs">{f.code}</td>
                <td className="text-xs text-text-muted">{f.source}</td>
                <td className="mono text-xs">{f.severity.toLowerCase()}{f.blocking ? " · blocking" : ""}</td>
                <td className="text-sm">{f.title}</td>
                <td className="text-xs">{f.supported ? <span className="text-success">executed</span> : <span className="text-text-faint">none — not acted on</span>}</td>
                <td className="mono text-xs">{f.status.toLowerCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

interface Card {
  agentKey: string;
  attempts: number;
  confidence: { level: string; note: string };
  taskSuccess: M;
  outputValidity: M;
  testPassRate: M | null;
  reviewDefectRate: M | null;
  repairSuccess: M | null;
  findingPrecision: M | null;
  avgLatencyMs: number | null;
  costPerSuccess: number | null;
  costEstimated: boolean;
  humanInterventionRate: M;
}
interface M {
  value: number | null;
  numerator: number;
  denominator: number;
  definition: string;
}

function Rate({ m, label }: { m: M | null; label: string }) {
  if (!m) return null;
  return (
    <div title={m.definition}>
      <dt className="metric-label">{label}</dt>
      <dd className="mono mt-0.5 text-sm">{m.value === null ? "—" : `${Math.round(m.value * 100)}%`} <span className="text-2xs text-text-faint">{m.numerator}/{m.denominator}</span></dd>
    </div>
  );
}

/** Mission-evidence scorecards. Shows sample size; refuses to rank on thin data. */
export function MissionScorecards({ companyId }: { companyId: string }) {
  const { data } = useQuery<Card[]>(`/api/companies/${companyId}/missions/scorecards`);
  if (!data) return <Skeleton className="h-32" />;
  if (!data.length) return <p className="text-sm text-text-muted">No evaluated mission attempts yet. Scorecards appear once agents have completed or failed tasks in your own missions (sample missions are excluded).</p>;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="mission-scorecards">
      {data.map((c) => (
        <div key={c.agentKey} className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <span className="mono text-sm">{c.agentKey}</span>
            <span className="mono text-2xs text-text-faint" title={c.confidence.note}>n={c.attempts} · {c.confidence.level}</span>
          </div>
          {c.confidence.level === "very-low" && <p className="mt-1 text-2xs text-warning">Not enough evidence to compare agents yet — indicative only.</p>}
          <dl className="mt-2 grid grid-cols-2 gap-2">
            <Rate m={c.taskSuccess} label="Task success" />
            <Rate m={c.outputValidity} label="Valid output" />
            <Rate m={c.testPassRate} label="Test pass" />
            <Rate m={c.reviewDefectRate} label="Changes w/ defects" />
            <Rate m={c.repairSuccess} label="Repair success" />
            <Rate m={c.findingPrecision} label="Finding precision" />
            <Rate m={c.humanInterventionRate} label="Needed a human" />
            <div><dt className="metric-label">Cost / success</dt><dd className="mono mt-0.5 text-sm">{c.costPerSuccess === null ? "—" : `$${c.costPerSuccess.toFixed(4)}`}{c.costEstimated && <span className="text-2xs text-text-faint"> est.</span>}</dd></div>
          </dl>
        </div>
      ))}
    </div>
  );
}

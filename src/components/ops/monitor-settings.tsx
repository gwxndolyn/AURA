"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useQuery, useMutation } from "@/hooks/useApi";
import { Skeleton } from "@/components/ui/primitives";
import { useApp } from "@/lib/store";
import { timeAgo } from "@/lib/utils";

interface Monitor {
  enabled: boolean;
  intervalSec: number;
  policyLevel: string;
  allowedAutoActions: string[];
  maxAutoActionsPerHour: number;
  notifyMinSeverity: string;
  aiSummaries: boolean;
  updatedBy: string;
  actions: { type: string; label: string; risk: string; autoEligible: boolean }[];
  runs: { id: string; trigger: string; status: string; opened: number; resolved: number; reopened: number; unknown: unknown[]; autoActions: number; durationMs: number; startedAt: string; error: string }[];
}

const LEVELS = [
  { id: "OBSERVE", label: "Observe", help: "Detect and explain. No state-changing action from here." },
  { id: "RECOMMEND", label: "Recommend", help: "Suggest actions; a person runs them." },
  { id: "BOUNDED", label: "Bounded", help: "Also run allow-listed low-risk actions automatically, rate-limited." },
  { id: "CONTINUOUS", label: "Continuous", help: "Bounded, on the monitor schedule. Never production or destructive actions." },
];

/** Monitor + autonomy policy. Saving requires ADMIN (enforced by the API). */
export function MonitorSettings({ companyId, onSaved }: { companyId: string; onSaved: () => void }) {
  const url = `/api/companies/${companyId}/ops/monitor`;
  const { data, refetch } = useQuery<Monitor>(url);
  const save = useMutation<Partial<Monitor>, Monitor>("PUT");
  const { toast } = useApp();
  const [draft, setDraft] = useState<Partial<Monitor>>({});
  useEffect(() => setDraft({}), [data]);
  if (!data) return <Skeleton className="mb-5 h-40" />;
  const v = { ...data, ...draft };

  async function submit() {
    try {
      await save.mutate(url, draft);
      toast({ title: "Monitor settings saved", level: "success" });
      refetch();
      onSaved();
    } catch (e) {
      toast({ title: "Not saved", description: (e as Error).message, level: "danger" });
    }
  }

  return (
    <section className="mb-5 rounded-lg border border-border p-4" aria-label="Monitor and policy" data-testid="monitor-settings">
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <div className="metric-label mb-1.5">Autonomy policy (enforced in code)</div>
          <div className="space-y-1">
            {LEVELS.map((l) => (
              <label key={l.id} className="flex cursor-pointer items-start gap-2 text-sm">
                <input type="radio" name="level" checked={v.policyLevel === l.id} onChange={() => setDraft((d) => ({ ...d, policyLevel: l.id }))} className="mt-1" />
                <span><span className="text-text">{l.label}</span> <span className="text-xs text-text-muted">— {l.help}</span></span>
              </label>
            ))}
          </div>
          <div className="metric-label mb-1 mt-3">Automatic actions allowed (Bounded/Continuous)</div>
          <div className="flex flex-wrap gap-2">
            {data.actions.filter((a) => a.autoEligible && a.risk === "low").map((a) => (
              <label key={a.type} className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={v.allowedAutoActions.includes(a.type)} onChange={(e) => setDraft((d) => ({ ...d, allowedAutoActions: e.target.checked ? [...v.allowedAutoActions, a.type] : v.allowedAutoActions.filter((x) => x !== a.type) }))} />
                {a.label}
              </label>
            ))}
          </div>
          <p className="mt-1 text-2xs text-text-faint">Cancel, resume and rollback are never automatic. Production changes always need a human approval.</p>
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={v.enabled} onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))} /> Monitoring enabled</label>
          <label className="flex items-center gap-2">Evaluate at most every <input type="number" min={30} max={86400} value={v.intervalSec} onChange={(e) => setDraft((d) => ({ ...d, intervalSec: Number(e.target.value) }))} className="input h-7 w-24" /> s</label>
          <label className="flex items-center gap-2">Max automatic actions / hour <input type="number" min={0} max={30} value={v.maxAutoActionsPerHour} onChange={(e) => setDraft((d) => ({ ...d, maxAutoActionsPerHour: Number(e.target.value) }))} className="input h-7 w-20" /></label>
          <label className="flex items-center gap-2">Notify at severity ≥
            <select value={v.notifyMinSeverity} onChange={(e) => setDraft((d) => ({ ...d, notifyMinSeverity: e.target.value }))} className="input h-7 w-28">{["low", "medium", "high", "critical"].map((s) => <option key={s}>{s}</option>)}</select>
          </label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={v.aiSummaries} onChange={(e) => setDraft((d) => ({ ...d, aiSummaries: e.target.checked }))} /> Allow AI summaries (one model call, on request)</label>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={submit} disabled={save.loading || Object.keys(draft).length === 0} className="btn-primary btn-sm">{save.loading && <Loader2 className="h-3 w-3 animate-spin" />} Save</button>
            <span className="text-2xs text-text-faint">Requires admin. {data.updatedBy && `Last changed by ${data.updatedBy}.`}</span>
          </div>
        </div>
      </div>
      <div className="mt-4">
        <div className="metric-label mb-1">Recent evaluation runs</div>
        <ul className="mono space-y-0.5 text-2xs text-text-muted" data-testid="monitor-runs">
          {data.runs.length === 0 ? <li>None yet.</li> : data.runs.map((r) => (
            <li key={r.id}>{timeAgo(r.startedAt)} · {r.trigger} · {r.status.toLowerCase()} · +{r.opened} opened · {r.resolved} resolved · {r.reopened} re-opened · {r.unknown.length} unknown · {r.autoActions} auto · {r.durationMs}ms{r.error ? ` · ${r.error}` : ""}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

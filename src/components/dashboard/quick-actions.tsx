"use client";

import { useState } from "react";
import { Hammer, ShieldCheck, Swords, Rocket, ShieldAlert, MessageSquare, Loader2, ChevronDown } from "lucide-react";
import { useMutation } from "@/hooks/useApi";
import { useApp } from "@/lib/store";

interface ActionDef {
  id: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  url: (id: string) => string;
  body?: unknown;
}

const ACTIONS: ActionDef[] = [
  { id: "build", label: "Build MVP", description: "Plan → implement → test → deploy", icon: Hammer, url: (id) => `/api/companies/${id}/build`, body: { goal: "Build the MVP" } },
  { id: "audit", label: "Security audit", description: "Scan and record findings", icon: ShieldCheck, url: (id) => `/api/companies/${id}/audit` },
  { id: "attack", label: "Range exercise", description: "Red vs blue in the isolated range", icon: Swords, url: (id) => `/api/companies/${id}/attack` },
  { id: "deploy", label: "Deploy to production", description: "Requires approval", icon: Rocket, url: (id) => `/api/companies/${id}/deploy`, body: { env: "production" } },
  { id: "chaos", label: "Inject chaos event", description: "Simulated infra failure", icon: ShieldAlert, url: (id) => `/api/companies/${id}/chaos` },
];

/**
 * Primary entry point to start work, plus a menu of other operations. One
 * filled button; everything else is secondary.
 */
export function QuickActions({ companyId, onCeo }: { companyId: string; onCeo?: () => void }) {
  const { mutate } = useMutation();
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function run(a: ActionDef) {
    setOpen(false);
    setBusy(a.id);
    toast({ title: `${a.label} started`, description: "Progress streams into the event log.", level: "info" });
    try {
      await mutate(a.url(companyId), a.body);
      toast({ title: `${a.label} finished`, level: "success" });
    } catch (e) {
      toast({ title: `${a.label} failed`, description: (e as Error).message, level: "danger" });
    } finally {
      setBusy(null);
    }
  }

  const build = ACTIONS[0];
  return (
    <div className="flex items-center gap-2">
      {onCeo && (
        <button onClick={onCeo} className="btn-ghost">
          <MessageSquare className="h-3.5 w-3.5" /> Ask CEO
        </button>
      )}
      <div className="relative">
        <button onClick={() => setOpen((o) => !o)} disabled={busy !== null} aria-haspopup="menu" aria-expanded={open} className="btn-secondary">
          Operations <ChevronDown className="h-3.5 w-3.5" />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <div role="menu" className="absolute right-0 top-9 z-40 w-72 rounded-lg border border-border-strong bg-bg-elevated p-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]">
              {ACTIONS.slice(1).map((a) => (
                <button key={a.id} role="menuitem" onClick={() => run(a)} className="flex w-full items-start gap-2.5 rounded px-2 py-2 text-left hover:bg-bg-hover">
                  <a.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-faint" />
                  <span>
                    <span className="block text-sm text-text">{a.label}</span>
                    <span className="block text-xs text-text-muted">{a.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <button onClick={() => run(build)} disabled={busy !== null} className="btn-primary" title={build.description}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <build.icon className="h-3.5 w-3.5" />}
        {busy ? "Working…" : build.label}
      </button>
    </div>
  );
}

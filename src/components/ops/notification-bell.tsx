"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { useQuery, fetchJSON } from "@/hooks/useApi";
import { cn, timeAgo } from "@/lib/utils";

interface Notif {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  href: string;
  read: boolean;
  createdAt: string;
}

/**
 * In-app notifications (one per open condition — no repeats) and the monitor
 * heartbeat: every minute the shell asks the server to reconcile health; the
 * server runs an evaluation only if the configured interval has elapsed and no
 * other run holds the lease. No model calls are involved.
 */
export function NotificationBell({ companyId }: { companyId: string }) {
  const { data, refetch } = useQuery<{ items: Notif[]; unread: number }>(`/api/companies/${companyId}/ops/notifications`, 30000);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    const beat = () => fetchJSON(`/api/companies/${companyId}/ops/monitor`, { method: "POST" }).then(() => !stop && refetch()).catch(() => {});
    beat();
    const t = setInterval(beat, 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [companyId, refetch]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  async function markAll() {
    const ids = (data?.items ?? []).filter((n) => !n.read).map((n) => n.id);
    if (ids.length) await fetchJSON(`/api/companies/${companyId}/ops/notifications`, { method: "POST", body: JSON.stringify({ ids }) }).catch(() => {});
    refetch();
  }

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} className="icon-btn relative" aria-label={`Notifications${data?.unread ? `, ${data.unread} unread` : ""}`} aria-expanded={open} data-testid="notification-bell">
        <Bell className="h-4 w-4" />
        {!!data?.unread && <span className="mono absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-danger px-0.5 text-[9px] leading-none text-white">{data.unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-[120] w-80 rounded-lg border border-border-strong bg-bg-elevated shadow-xl" role="dialog" aria-label="Notifications">
          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-sm">
            <span className="font-medium">Notifications</span>
            <button onClick={markAll} className="btn-ghost btn-sm">Mark all read</button>
          </div>
          {!data?.items.length ? (
            <p className="px-3 py-4 text-xs text-text-muted">Nothing needs you. Notifications appear for findings that need a person or reach your severity threshold.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-border-subtle overflow-y-auto">
              {data.items.map((n) => (
                <li key={n.id}>
                  <Link href={`/app/${companyId}${n.href}`} onClick={() => setOpen(false)} className={cn("block px-3 py-2 hover:bg-bg-hover", !n.read && "bg-bg-raised")}>
                    <span className="flex items-center gap-1.5 text-xs"><span className={cn("dot", n.severity === "high" || n.severity === "critical" ? "bg-danger" : n.severity === "medium" ? "bg-warning" : "bg-text-faint")} /><span className="mono text-2xs text-text-faint">{n.kind}</span><span className="ml-auto mono text-2xs text-text-faint">{timeAgo(n.createdAt)}</span></span>
                    <span className="mt-0.5 block text-sm text-text">{n.title}</span>
                    <span className="block truncate text-2xs text-text-muted">{n.body}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

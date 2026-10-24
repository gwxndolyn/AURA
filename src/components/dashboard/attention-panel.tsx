"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { useMutation } from "@/hooks/useApi";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export interface AttentionItem {
  id: string;
  level: "danger" | "warning" | "info" | "success";
  title: string;
  detail: string;
  href?: string;
  action?: { label: string; method: "POST"; path: string; body?: Record<string, unknown> };
}

const LABEL = { danger: "Urgent", warning: "Review", info: "Info", success: "Done" };
const TONE = { danger: "text-danger border-danger/30", warning: "text-warning border-warning/30", info: "text-info border-info/30", success: "text-success border-success/30" };

/** "Needs you" list: computed server-side from real state (approvals, incidents, findings, budget, blocked tasks). */
export function AttentionPanel({ companyId, items, onChange }: { companyId: string; items: AttentionItem[]; onChange?: () => void }) {
  const { mutate } = useMutation();
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);

  async function runAction(item: AttentionItem) {
    if (!item.action) return;
    setBusy(item.id);
    try {
      await mutate(item.action.path, item.action.body);
      toast({ title: `${item.action.label}: done`, description: item.title, level: "success" });
      onChange?.();
    } catch (e) {
      toast({ title: `${item.action.label} failed`, description: (e as Error).message, level: "danger" });
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return <p className="px-3 py-4 text-sm text-text-muted">Nothing needs a decision. Pending approvals, open incidents, high-severity findings and blocked tasks appear here.</p>;
  }

  return (
    <ul className="divide-y divide-border-subtle">
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5 sm:flex-nowrap">
          <span className={cn("chip mt-px shrink-0 border", TONE[item.level])}>{LABEL[item.level]}</span>
          <div className="min-w-0 flex-1 basis-[calc(100%-80px)] sm:basis-auto">
            <div className="text-sm text-text">{item.title}</div>
            <div className="mt-0.5 text-xs text-text-muted">{item.detail}</div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {item.href && (
              <Link href={`/app/${companyId}${item.href}`} className="btn-ghost btn-sm" aria-label={`Open ${item.title}`}>
                Open <ArrowUpRight className="h-3 w-3" />
              </Link>
            )}
            {item.action && (
              <button onClick={() => runAction(item)} disabled={busy === item.id} className="btn-secondary btn-sm">
                {busy === item.id && <Loader2 className="h-3 w-3 animate-spin" />}
                {item.action.label}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

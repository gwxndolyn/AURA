"use client";

import { labEnabled } from "@/lib/lab";
import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Search } from "lucide-react";
import { useQuery } from "@/hooks/useApi";
import { useApp } from "@/lib/store";
import { StatusDot } from "@/components/ui/primitives";
import { SimControls } from "./sim-controls";
import { navItemFor } from "./nav";
import { Tour } from "@/components/onboarding/tour";
import { NotificationBell } from "@/components/ops/notification-bell";

interface AiStatus {
  mode: "live" | "simulation";
  sandbox: "docker" | "simulated";
}

/**
 * Compact top bar: breadcrumb (workspace / section), search, then the real
 * runtime context: sim clock, AI mode, sandbox mode, spend. Every element is
 * functional or a factual readout — no decorative controls.
 */
export function Topbar({
  companyId,
  companyName,
  status,
  cost,
  onOpenNav,
}: {
  companyId: string;
  companyName: string;
  status: string;
  cost: number;
  onOpenNav: () => void;
}) {
  const pathname = usePathname();
  const { data: ai } = useQuery<AiStatus>("/api/ai/status");
  const { setCommandOpen } = useApp();
  const section = navItemFor(pathname, companyId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCommandOpen]);

  return (
    <header className="z-20 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg px-3 md:px-4">
      <button onClick={onOpenNav} className="icon-btn md:hidden" aria-label="Open navigation">
        <Menu className="h-4 w-4" />
      </button>

      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
        <Link href={`/app/${companyId}`} aria-label={companyName === "…" ? "Workspace home" : undefined} className={`truncate text-text-muted hover:text-text ${section && section.href !== "" ? "hidden sm:inline" : ""}`}>
          {companyName === "…" ? <span className="skeleton inline-block h-3 w-20 align-middle" /> : companyName}
        </Link>
        <span className="hidden sm:inline">
          {labEnabled() && <StatusDot status={status} />}
        </span>
        {section && section.href !== "" && (
          <>
            <span className="hidden text-text-faint sm:inline">/</span>
            <span className="truncate font-medium text-text">{section.label}</span>
          </>
        )}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={() => setCommandOpen(true)}
          className="hidden h-7 w-56 items-center gap-2 rounded-md border border-border bg-bg-inset px-2 text-xs text-text-faint transition-colors hover:border-border-strong hover:text-text-muted lg:flex"
          aria-label="Search and commands"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">Search or run a command</span>
          <span className="kbd">⌘K</span>
        </button>
        <button onClick={() => setCommandOpen(true)} className="icon-btn lg:hidden" aria-label="Search and commands">
          <Search className="h-4 w-4" />
        </button>

        {labEnabled() && <SimControls companyId={companyId} />}
        <NotificationBell companyId={companyId} />
        <Tour companyId={companyId} />

        <div className="hidden items-center divide-x divide-border rounded-md border border-border text-2xs xl:flex">
          <span className="mono flex h-7 items-center gap-1.5 px-2 text-text-muted" title={ai?.mode === "live" ? "Agents call the configured AI provider" : "No AI provider is configured on this server: planning and engineering runs cannot start"}>
            {ai && <span className={`dot ${ai.mode === "live" ? "bg-success" : "bg-warning"}`} />}
            {ai ? (ai.mode === "live" ? "AI connected" : "AI not configured") : <span className="skeleton inline-block h-2 w-14" />}
          </span>
          <span className="mono flex h-7 items-center gap-1.5 px-2 text-text-muted" title={ai?.sandbox === "docker" ? "Generated code runs in the isolated sandbox" : "Execution sandbox unavailable: engineering runs wait until it is back"}>
            {ai && <span className={`dot ${ai.sandbox === "docker" ? "bg-success" : "bg-text-faint"}`} />}
            {ai ? (ai.sandbox === "docker" ? "sandbox ready" : "sandbox offline") : <span className="skeleton inline-block h-2 w-14" />}
          </span>
          <span className="mono flex h-7 items-center px-2 text-text-muted" title="Estimated AI spend for this workspace (not billed cost)">
            ${cost.toFixed(cost < 10 ? 2 : 0)} est.
          </span>
        </div>
      </div>
    </header>
  );
}

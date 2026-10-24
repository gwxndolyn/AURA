"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, LogOut, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@/hooks/useApi";
import { visibleGroups, visibleFooter, type NavItem } from "./nav";

interface Me {
  user: { id: string; email: string; name: string } | null;
  workspaces: { id: string; name: string; status: string; role: string }[];
}

/** AURA mark: a simple geometric glyph, no gradient. */
export function AuraMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={cn("h-5 w-5", className)} aria-hidden>
      <rect x="0.5" y="0.5" width="19" height="19" rx="4.5" className="fill-bg-elevated stroke-border-strong" />
      <path d="M5.5 14.5 10 5l4.5 9.5" fill="none" strokeWidth="1.6" strokeLinejoin="round" className="stroke-text" />
      <path d="M7.4 11h5.2" strokeWidth="1.6" className="stroke-brand" />
    </svg>
  );
}

function NavLink({ item, base, pathname, onNavigate }: { item: NavItem; base: string; pathname: string; onNavigate?: () => void }) {
  const href = `${base}${item.href}`;
  const active = item.href === "" ? pathname === base : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-7 items-center gap-2.5 rounded-md px-2 text-sm transition-colors",
        active ? "bg-bg-hover text-text" : "text-text-muted hover:bg-bg-elevated hover:text-text",
      )}
    >
      {active && <span className="absolute -left-2 top-1.5 h-4 w-[2px] rounded-full bg-brand" aria-hidden />}
      <item.icon className={cn("h-[15px] w-[15px] shrink-0", active ? "text-text" : "text-text-faint group-hover:text-text-muted")} />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function WorkspaceSwitcher({ companyId, me, fallbackName }: { companyId: string; me: Me | null; fallbackName?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const current = me?.workspaces.find((w) => w.id === companyId);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-bg-elevated"
      >
        <AuraMark />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-4">{current?.name ?? fallbackName ?? "…"}</div>
          <div className="mono truncate text-2xs leading-3 text-text-faint">{current ? current.role.toLowerCase() : " "}</div>
        </div>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-text-faint" />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 right-0 top-10 z-50 rounded-lg border border-border-strong bg-bg-elevated p-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]">
          <div className="metric-label px-2 pb-1 pt-1.5">Workspaces</div>
          {(me?.workspaces ?? []).map((w) => (
            <button
              key={w.id}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                router.push(`/app/${w.id}`);
              }}
              className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-bg-hover"
            >
              <span className="flex-1 truncate">{w.name}</span>
              {w.id === companyId && <Check className="h-3.5 w-3.5 text-text-muted" />}
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          <Link role="menuitem" href="/onboarding" className="flex h-8 items-center gap-2 rounded px-2 text-sm text-text-muted hover:bg-bg-hover hover:text-text">
            <Plus className="h-3.5 w-3.5" /> New company
          </Link>
          <Link role="menuitem" href="/app" className="flex h-8 items-center gap-2 rounded px-2 text-sm text-text-muted hover:bg-bg-hover hover:text-text">
            All companies
          </Link>
        </div>
      )}
    </div>
  );
}

function UserRow({ me }: { me: Me | null }) {
  const router = useRouter();
  if (!me?.user) return null;
  const initials = me.user.name
    .split(/\s+/)
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="flex items-center gap-2 px-2 py-2">
      <div className="mono flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-hover text-2xs text-text-muted">{initials}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-text">{me.user.name}</div>
        <div className="truncate text-2xs text-text-faint">{me.user.email}</div>
      </div>
      <button
        className="icon-btn"
        title="Sign out"
        aria-label="Sign out"
        onClick={async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          router.push("/login");
        }}
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function SidebarBody({ companyId, companyName, onNavigate }: { companyId: string; companyName?: string; onNavigate?: () => void }) {
  const pathname = usePathname();
  const base = `/app/${companyId}`;
  const { data: me } = useQuery<Me>("/api/auth/me");
  return (
    <>
      <div className="px-2 pb-2 pt-2.5">
        <WorkspaceSwitcher companyId={companyId} me={me} fallbackName={companyName} />
      </div>
      <nav aria-label="Workspace" className="flex-1 space-y-4 overflow-y-auto px-3 pb-3 pt-1">
        {visibleGroups().map((g) => (
          <div key={g.label}>
            <div className="metric-label px-2 pb-1">{g.label}</div>
            <div className="space-y-px">
              {g.items.map((item) => (
                <NavLink key={item.href} item={item} base={base} pathname={pathname} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-border px-3 py-2">
        <div className="space-y-px">
          {visibleFooter().map((item) => (
            <NavLink key={item.href} item={item} base={base} pathname={pathname} onNavigate={onNavigate} />
          ))}
        </div>
      </div>
      <div className="border-t border-border px-1">
        <UserRow me={me} />
      </div>
    </>
  );
}

export function Sidebar({ companyId, companyName }: { companyId: string; companyName?: string }) {
  return (
    <aside className="hidden w-[224px] shrink-0 flex-col border-r border-border bg-bg-raised md:flex">
      <SidebarBody companyId={companyId} companyName={companyName} />
    </aside>
  );
}

/** Mobile navigation drawer (replaces the sidebar below md). */
export function MobileSidebar({ companyId, companyName, open, onClose }: { companyId: string; companyName?: string; open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <aside className="absolute inset-y-0 left-0 flex w-[264px] animate-fade-in flex-col border-r border-border bg-bg-raised">
        <button onClick={onClose} className="icon-btn absolute -right-10 top-2.5 z-10 bg-bg-raised" aria-label="Close navigation">
          <X className="h-4 w-4" />
        </button>
        <SidebarBody companyId={companyId} companyName={companyName} onNavigate={onClose} />
      </aside>
    </div>
  );
}

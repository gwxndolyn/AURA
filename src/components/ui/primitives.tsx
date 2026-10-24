"use client";

import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

/**
 * Shared UI primitives for AURA. Pages compose these instead of re-styling.
 * Visual rules: neutral surfaces, 1px borders, accent only for primary/active,
 * status is never conveyed by color alone (always a label or icon too).
 */

export type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("card p-4", className)} {...props}>
      {children}
    </div>
  );
}

const BADGE_TONES: Record<Tone, string> = {
  neutral: "bg-bg-elevated text-text-muted border border-border",
  brand: "bg-brand/10 text-brand-glow border border-brand/25",
  success: "bg-success/10 text-success border border-success/25",
  warning: "bg-warning/10 text-warning border border-warning/25",
  danger: "bg-danger/10 text-danger border border-danger/25",
  info: "bg-info/10 text-info border border-info/25",
};

export function Badge({ children, className, tone = "neutral" }: { children: React.ReactNode; className?: string; tone?: Tone }) {
  return <span className={cn("chip", BADGE_TONES[tone], className)}>{children}</span>;
}

export const STATUS_TONE: Record<string, Tone> = {
  // agent
  IDLE: "neutral",
  THINKING: "info",
  WORKING: "brand",
  WAITING: "warning",
  BLOCKED: "warning",
  FAILED: "danger",
  COMPLETED: "success",
  // company
  BUILDING: "info",
  OPERATING: "success",
  INCIDENT: "danger",
  UNDER_ATTACK: "danger",
  RECOVERING: "warning",
  // tasks
  BACKLOG: "neutral",
  PLANNED: "neutral",
  IN_PROGRESS: "brand",
  REVIEW: "warning",
  TESTING: "info",
  DONE: "success",
  // severity
  LOW: "neutral",
  MEDIUM: "info",
  HIGH: "warning",
  CRITICAL: "danger",
  // generic
  OPEN: "danger",
  PATCHING: "warning",
  FIXED: "info",
  VERIFIED: "success",
  ACTIVE: "danger",
  CONTAINED: "warning",
  RESOLVED: "success",
  SUCCESS: "success",
  PENDING: "neutral",
  PENDING_APPROVAL: "warning",
  REJECTED: "danger",
  RUNNING: "brand",
  ROLLED_BACK: "warning",
  HEALTHY: "success",
  DEGRADED: "warning",
  DOWN: "danger",
  // missions
  DRAFT: "neutral",
  PLANNING: "info",
  AWAITING_APPROVAL: "warning",
  READY: "info",
  PAUSED: "warning",
  CANCELLED: "neutral",
  WAITING_APPROVAL: "warning",
  SUCCEEDED: "success",
  SKIPPED: "neutral",
  APPROVED: "success",
  EXPIRED: "neutral",
  PROPOSED: "warning",
  SUPERSEDED: "neutral",
};

const DOT_CLASS: Record<Tone, string> = {
  neutral: "bg-text-faint",
  brand: "bg-brand",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

/** Text label + colored dot. Labels are always present (color is never the only signal). */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  return (
    <Badge tone={tone} className={className}>
      <span className={cn("dot", DOT_CLASS[tone], (status === "WORKING" || status === "RUNNING" || status === "THINKING") && "animate-live-dot")} />
      {status.replace(/_/g, " ").toLowerCase()}
    </Badge>
  );
}

/** Bare dot + label (no chip), for dense rows. */
export function StatusDot({ status, label }: { status: string; label?: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
      <span className={cn("dot", DOT_CLASS[tone], (status === "WORKING" || status === "RUNNING" || status === "THINKING") && "animate-live-dot")} />
      {label ?? status.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

/** Number that eases to its target. Respects prefers-reduced-motion. */
export function AnimatedNumber({ value, format, className }: { value: number; format?: (n: number) => string; className?: string }) {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  const raf = useRef<number>();

  useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setDisplay(value);
      prev.current = value;
      return;
    }
    const from = prev.current;
    const to = value;
    const start = performance.now();
    const dur = 400;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * eased);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value]);

  return <span className={className}>{format ? format(display) : Math.round(display)}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <div role="status" aria-label="Loading" className={cn("h-3.5 w-3.5 animate-spin rounded-full border-2 border-border-strong border-t-text-muted", className)} />;
}

/** Contextual empty state: what this area is for and what to do next. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-start gap-1 px-4", compact ? "py-6" : "py-10")}>
      <div className="flex items-center gap-2 text-sm font-medium text-text">
        <Icon className="h-4 w-4 text-text-faint" />
        {title}
      </div>
      <p className="max-w-md text-sm text-text-muted">{description}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Failed request: say what failed and offer a retry. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2.5 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-text">Couldn&apos;t load this data</div>
        <div className="mono mt-0.5 break-words text-xs text-text-muted">{message}</div>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary btn-sm">
          <RotateCw className="h-3 w-3" /> Retry
        </button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton", className)} />;
}

/** Standard page header: title, optional description/meta, actions on the right. */
export function PageHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="page-title">{title}</h1>
          {meta}
        </div>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Section within a page: small uppercase title, optional right slot, content below. */
export function Section({
  title,
  icon: Icon,
  aside,
  children,
  className,
}: {
  title: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
        <h2 className="section-title">
          {Icon && <Icon className="h-3.5 w-3.5 text-text-faint" />}
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Label/value pair for dense inline stats ("Customers 142"). */
export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: Tone }) {
  const color = tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-text";
  return (
    <div className="min-w-0">
      <div className="metric-label">{label}</div>
      <div className={cn("mono mt-1 text-lg font-medium leading-6", color)}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-2xs text-text-faint">{hint}</div>}
    </div>
  );
}

/** Banner that marks simulated / demo data so it is never mistaken for live ops. */
export function SimulatedNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-bg-raised px-3 py-1.5 text-xs text-text-muted">
      <span className="chip border border-border-strong text-text-muted">SIM</span>
      {children}
    </div>
  );
}

/**
 * Agent identity mark. Agents keep their registry color as a small,
 * low-saturation identifier — not a glowing avatar.
 */
export function AgentAvatar({ avatar, color, size = 28, active }: { avatar: string; color: string; size?: number; active?: boolean }) {
  return (
    <div
      className="relative flex shrink-0 items-center justify-center rounded-md font-semibold mono"
      style={{
        width: size,
        height: size,
        background: `${color}14`,
        color,
        boxShadow: `inset 0 0 0 1px ${color}33`,
        fontSize: Math.max(9, size * 0.34),
      }}
      aria-hidden
    >
      {avatar}
      {active && <span className="dot absolute -right-0.5 -top-0.5 animate-live-dot bg-brand ring-2 ring-bg-raised" />}
    </div>
  );
}

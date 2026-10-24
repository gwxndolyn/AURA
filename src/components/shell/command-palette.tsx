"use client";

import { labEnabled } from "@/lib/lab";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  Hammer,
  ShieldCheck,
  Swords,
  Rocket,
  Users,
  Code2,
  MessageSquare,
  Search,
  Radar,
  LayoutDashboard,
  FolderKanban,
  BarChart3,
  GitBranch,
  Activity,
  ShieldAlert,
  Server,
  Building2,
  FlaskConical,
  CornerDownLeft,
  Settings,
  Target,
  PlayCircle,
  HelpCircle,
  Gauge,
  Network,
  Boxes,
  Building,
} from "lucide-react";
import { useApp } from "@/lib/store";
import { useMutation, fetchJSON } from "@/hooks/useApi";

interface Cmd {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void | Promise<void>;
  kind: "nav" | "action";
}

interface SearchResult {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}

export function CommandPalette({ companyId }: { companyId: string }) {
  const { commandOpen, setCommandOpen, toast } = useApp();
  const router = useRouter();
  const { mutate } = useMutation();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  const go = (path: string) => () => {
    router.push(`/app/${companyId}${path}`);
    setCommandOpen(false);
  };

  const action = (label: string, url: string, body?: unknown) => async () => {
    setCommandOpen(false);
    toast({ title: `${label}…`, level: "info" });
    try {
      await mutate(url, body);
      toast({ title: `${label} complete`, level: "success" });
    } catch (e) {
      toast({ title: `${label} failed`, description: (e as Error).message, level: "danger" });
    }
  };

  const LAB_COMMANDS = new Set(["twin", "company", "projects", "deployments", "cyber", "incidents", "infra", "analytics", "decisions", "build", "sprint", "audit", "attack", "deploy", "stress", "ceo"]);
  const allCommands: Cmd[] = [
    { id: "overview", label: "Go to Home", icon: LayoutDashboard, run: go(""), kind: "nav" },
    { id: "missions", label: "Go to Missions", icon: Target, run: go("/missions"), kind: "nav" },
    { id: "operations", label: "Go to Operations", icon: Gauge, run: go("/operations"), kind: "nav" },
    { id: "office", label: "Go to Office", icon: Building, run: go("/office"), kind: "nav" },
    { id: "products", label: "Go to Products", icon: Boxes, run: go("/products"), kind: "nav" },
    { id: "twin", label: "Go to Company twin", icon: Network, run: go("/twin"), kind: "nav" },
    { id: "example", label: "Run example mission", icon: PlayCircle, run: go("/missions?example=1"), kind: "action" },
    { id: "tour", label: "Open the product tour", icon: HelpCircle, run: () => { window.dispatchEvent(new CustomEvent("aura:tour", { detail: "open" })); setCommandOpen(false); }, kind: "action" },
    { id: "company", label: "Go to Company", icon: Building2, run: go("/company"), kind: "nav" },
    { id: "agents", label: "Go to Agents", icon: Users, run: go("/agents"), kind: "nav" },
    { id: "projects", label: "Go to Work", icon: FolderKanban, run: go("/projects"), kind: "nav" },
    { id: "code", label: "Go to Code Workspace", icon: Code2, run: go("/code"), kind: "nav" },
    { id: "deployments", label: "Go to Deployments", icon: Rocket, run: go("/deployments"), kind: "nav" },
    { id: "cyber", label: "Go to Cyber Range", icon: Radar, run: go("/cyber-range"), kind: "nav" },
    { id: "incidents", label: "Go to Security & Incidents", icon: ShieldAlert, run: go("/incidents"), kind: "nav" },
    { id: "infra", label: "Go to Infrastructure", icon: Server, run: go("/infrastructure"), kind: "nav" },
    { id: "analytics", label: "Go to Analytics", icon: BarChart3, run: go("/analytics"), kind: "nav" },
    { id: "decisions", label: "Go to Decisions", icon: GitBranch, run: go("/decisions"), kind: "nav" },
    { id: "activity", label: "Go to Activity & Audit", icon: Activity, run: go("/activity"), kind: "nav" },
    { id: "intelligence", label: "Go to AI Evaluation", icon: FlaskConical, run: go("/intelligence"), kind: "nav" },
    { id: "settings", label: "Go to Settings", icon: Settings, run: go("/settings"), kind: "nav" },
    { id: "health", label: "Go to System Health", icon: Server, run: () => { router.push("/health"); setCommandOpen(false); }, kind: "nav" },
    { id: "build", label: "Build the MVP", icon: Hammer, run: action("Build", `/api/companies/${companyId}/build`, { goal: "Build the MVP" }), kind: "action" },
    { id: "sprint", label: "Plan a Sprint", icon: FolderKanban, run: action("Sprint planning", `/api/companies/${companyId}/sprint`), kind: "action" },
    { id: "audit", label: "Run Security Audit", icon: ShieldCheck, run: action("Security audit", `/api/companies/${companyId}/audit`), kind: "action" },
    { id: "attack", label: "Simulate Attack", icon: Swords, run: action("Attack simulation", `/api/companies/${companyId}/attack`), kind: "action" },
    { id: "deploy", label: "Deploy to Production", icon: Rocket, run: action("Deploy", `/api/companies/${companyId}/deploy`, { env: "production" }), kind: "action" },
    { id: "stress", label: "Run Stress Test", icon: FlaskConical, run: action("Stress test", `/api/companies/${companyId}/stress-test`), kind: "action" },
    { id: "ceo", label: "Ask the AI CEO", icon: MessageSquare, run: go("/company"), kind: "nav" },
  ];
  // Simulation-lab commands only when the lab is enabled.
  const commands = allCommands.filter((c) => labEnabled() || !LAB_COMMANDS.has(c.id));

  const filtered = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));

  useEffect(() => {
    if (!commandOpen) {
      setQ("");
      setResults([]);
      setActive(0);
    }
  }, [commandOpen]);

  // Debounced global search.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const r = await fetchJSON<SearchResult[]>(`/api/companies/${companyId}/search?q=${encodeURIComponent(q)}`);
        setResults(r);
      } catch {
        setResults([]);
      }
    }, 180);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q, companyId]);

  const openResult = (r: SearchResult) => {
    router.push(`/app/${companyId}${r.href}`);
    setCommandOpen(false);
  };

  const items: ({ key: string; group: string; label: string; hint?: string; icon: React.ComponentType<{ className?: string }>; run: () => void })[] = [
    ...results.map((r) => ({ key: `r-${r.type}-${r.id}`, group: "Results", label: r.title, hint: r.subtitle ?? r.type, icon: CornerDownLeft, run: () => openResult(r) })),
    ...filtered.filter((c) => c.kind === "nav").map((c) => ({ key: c.id, group: "Go to", label: c.label.replace(/^Go to /, ""), icon: c.icon, run: () => void c.run() })),
    ...filtered.filter((c) => c.kind === "action").map((c) => ({ key: c.id, group: "Run", label: c.label, icon: c.icon, run: () => void c.run() })),
  ];
  const clamped = Math.min(active, Math.max(0, items.length - 1));

  return (
    <AnimatePresence>
      {commandOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[14vh]"
          onClick={() => setCommandOpen(false)}
        >
          <motion.div
            initial={{ y: -4, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -4, opacity: 0 }}
            transition={{ duration: 0.14 }}
            role="dialog"
            aria-modal="true"
            aria-label="Command menu"
            className="w-full max-w-[560px] overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="h-4 w-4 text-text-faint" />
              <input
                autoFocus
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                placeholder="Search tasks, agents, findings… or type a command"
                aria-label="Search or run a command"
                className="h-11 flex-1 bg-transparent text-sm placeholder:text-text-faint focus:outline-none"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setCommandOpen(false);
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, items.length - 1));
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  }
                  if (e.key === "Enter") items[clamped]?.run();
                }}
              />
              <span className="kbd">esc</span>
            </div>
            <div className="max-h-[380px] overflow-y-auto p-1" role="listbox">
              {items.length === 0 && <div className="px-3 py-6 text-sm text-text-muted">No commands or results match “{q}”.</div>}
              {items.map((it, i) => (
                <div key={it.key}>
                  {(i === 0 || items[i - 1].group !== it.group) && <div className="metric-label px-2 pb-1 pt-2">{it.group}</div>}
                  <button
                    role="option"
                    aria-selected={i === clamped}
                    onMouseMove={() => setActive(i)}
                    onClick={it.run}
                    className={`flex h-8 w-full items-center gap-2.5 rounded px-2 text-left text-sm ${i === clamped ? "bg-bg-hover text-text" : "text-text-muted"}`}
                  >
                    <it.icon className="h-3.5 w-3.5 shrink-0 text-text-faint" />
                    <span className="flex-1 truncate">{it.label}</span>
                    {it.hint && <span className="mono text-2xs text-text-faint">{it.hint}</span>}
                    {i === clamped && <CornerDownLeft className="h-3 w-3 text-text-faint" />}
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-2xs text-text-faint">
              <span className="flex items-center gap-1"><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span>
              <span className="flex items-center gap-1"><span className="kbd">↵</span> run</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

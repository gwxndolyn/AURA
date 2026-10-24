import {
  Microscope,
  Bot,
  LayoutDashboard,
  Building2,
  Users,
  FolderKanban,
  Code2,
  Rocket,
  Radar,
  ShieldAlert,
  Server,
  BarChart3,
  GitBranch,
  Activity,
  Settings,
  FlaskConical,
  Target,
  Gauge,
  Network,
  Boxes,
  Building,
} from "lucide-react";

export interface NavItem {
  href: string; // relative to /app/[id]
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Simulation-lab surface (hidden unless the lab is enabled). */
  lab?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Single source of truth for workspace navigation (sidebar, mobile drawer, breadcrumbs). */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operate",
    items: [
      { href: "", label: "Home", icon: LayoutDashboard },
      { href: "/lab", label: "Simulation lab", icon: FlaskConical, lab: true },
      { href: "/products", label: "Products", icon: Boxes },
      { href: "/office", label: "Office", icon: Building },
      { href: "/missions", label: "Missions", icon: Target },
      { href: "/operations", label: "Operations", icon: Gauge },
      { href: "/twin", label: "Company twin", icon: Network, lab: true },
      { href: "/projects", label: "Work", icon: FolderKanban, lab: true },
      { href: "/agents", label: "Agents", icon: Users },
      { href: "/decisions", label: "Decisions", icon: GitBranch, lab: true },
    ],
  },
  {
    label: "Ship",
    items: [
      { href: "/code", label: "Code", icon: Code2 },
      { href: "/deployments", label: "Deployments", icon: Rocket, lab: true },
      { href: "/infrastructure", label: "Infrastructure", icon: Server, lab: true },
    ],
  },
  {
    label: "Security",
    items: [
      { href: "/incidents", label: "Incidents", icon: ShieldAlert, lab: true },
      { href: "/cyber-range", label: "Cyber Range", icon: Radar, lab: true },
    ],
  },
  {
    label: "Insight",
    items: [
      { href: "/analytics", label: "Analytics", icon: BarChart3, lab: true },
      { href: "/intelligence", label: "AI Evaluation", icon: FlaskConical },
      { href: "/engineering-lab", label: "Engineering Lab", icon: Microscope },
      { href: "/autopilot", label: "Autopilot", icon: Bot },
      { href: "/activity", label: "Activity & Audit", icon: Activity },
    ],
  },
];

export const NAV_FOOTER: NavItem[] = [
  { href: "/company", label: "Company", icon: Building2, lab: true },
  { href: "/settings", label: "Settings", icon: Settings },
];

import { labEnabled } from "@/lib/lab";

/** Groups/items visible in this deployment (simulation-lab items only when the lab is on). */
export function visibleGroups(): NavGroup[] {
  const lab = labEnabled();
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => lab || !i.lab) })).filter((g) => g.items.length);
}
export function visibleFooter(): NavItem[] {
  return NAV_FOOTER.filter((i) => labEnabled() || !i.lab);
}

export const ALL_NAV: NavItem[] = [...NAV_GROUPS.flatMap((g) => g.items), ...NAV_FOOTER];

/** Find the nav item for a pathname under /app/[id]. */
export function navItemFor(pathname: string, companyId: string): NavItem | undefined {
  const base = `/app/${companyId}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  return ALL_NAV.find((i) => (i.href === "" ? rest === "" || rest === "/" : rest === i.href || rest.startsWith(`${i.href}/`)));
}

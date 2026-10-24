"use client";

import { useMemo } from "react";
import ReactFlow, { Background, BackgroundVariant, Edge, Handle, Node, Position } from "reactflow";
import { palette } from "@/lib/theme";

interface AgentLite {
  key: string;
  name: string;
  role: string;
  avatar: string;
  color: string;
  status: string;
}

// Org structure: CEO -> PM -> Architect -> (eng) ; security spans engineering.
const LAYOUT: Record<string, { x: number; y: number }> = {
  ceo: { x: 300, y: 0 },
  "product-manager": { x: 300, y: 90 },
  architect: { x: 300, y: 180 },
  "frontend-engineer": { x: 60, y: 290 },
  "backend-engineer": { x: 220, y: 290 },
  devops: { x: 380, y: 290 },
  "qa-engineer": { x: 540, y: 290 },
  "security-engineer": { x: 300, y: 400 },
  "red-team": { x: 140, y: 400 },
  "blue-team": { x: 460, y: 400 },
  "data-analyst": { x: 60, y: 180 },
  support: { x: 540, y: 180 },
};

const EDGES: [string, string][] = [
  ["ceo", "product-manager"],
  ["product-manager", "architect"],
  ["architect", "frontend-engineer"],
  ["architect", "backend-engineer"],
  ["architect", "devops"],
  ["architect", "qa-engineer"],
  ["security-engineer", "backend-engineer"],
  ["security-engineer", "red-team"],
  ["security-engineer", "blue-team"],
  ["product-manager", "data-analyst"],
  ["product-manager", "support"],
];

function OrgNode({ data }: { data: AgentLite }) {
  const active = data.status !== "IDLE" && data.status !== "COMPLETED";
  return (
    <div className="flex items-center gap-2 rounded-md border border-border-strong bg-bg-raised px-2 py-1.5">
      <Handle type="target" position={Position.Top} />
      <div className="mono flex h-5 w-5 items-center justify-center rounded text-[9px] font-semibold" style={{ background: `${data.color}14`, color: data.color, boxShadow: `inset 0 0 0 1px ${data.color}33` }}>
        {data.avatar}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-[11px] font-medium leading-tight text-text">
          {data.name}
          {active && <span className="dot animate-live-dot bg-brand" />}
        </div>
        <div className="text-[9.5px] leading-tight text-text-faint">{data.role}</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { org: OrgNode };

export function OrgGraph({ agents }: { agents: AgentLite[] }) {
  const nodes: Node[] = useMemo(
    () =>
      agents
        .filter((a) => LAYOUT[a.key])
        .map((a) => ({
          id: a.key,
          type: "org",
          position: LAYOUT[a.key],
          data: a,
          draggable: true,
        })),
    [agents],
  );

  const present = new Set(agents.map((a) => a.key));
  const edges: Edge[] = EDGES.filter(([a, b]) => present.has(a) && present.has(b)).map(([a, b]) => ({
    id: `${a}-${b}`,
    source: a,
    target: b,
    style: { stroke: palette.border.strong, strokeWidth: 1 },
  }));

  return (
    <div className="h-[460px]" aria-label="Organization chart">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView proOptions={{ hideAttribution: true }} nodesConnectable={false}>
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color={palette.border.DEFAULT} />
      </ReactFlow>
    </div>
  );
}

"use client";

import { useMemo } from "react";
import ReactFlow, { Background, Edge, Node, Handle, Position, BackgroundVariant } from "reactflow";
import { palette } from "@/lib/theme";

interface InfraNode {
  id: string;
  key: string;
  label: string;
  kind: string;
  status: string;
  cpu: number;
  latencyMs: number;
  errorRate: number;
  posX: number;
  posY: number;
}

const STATUS_COLOR: Record<string, string> = {
  HEALTHY: palette.success,
  DEGRADED: palette.warning,
  DOWN: palette.danger,
  UNDER_ATTACK: palette.danger,
};

const EDGES: [string, string][] = [
  ["waf", "lb"],
  ["lb", "api"],
  ["api", "app"],
  ["api", "auth"],
  ["api", "payment"],
  ["app", "db"],
  ["auth", "admin"],
  ["app", "logging"],
  ["payment", "logging"],
];

function ServiceNode({ data }: { data: InfraNode }) {
  const color = STATUS_COLOR[data.status] ?? palette.text.muted;
  const hot = data.status !== "HEALTHY";
  return (
    <div className="min-w-[136px] rounded-md border bg-bg-raised px-2.5 py-1.5" style={{ borderColor: hot ? `${color}88` : palette.border.strong }}>
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-1.5">
        <span className="dot" style={{ background: color }} />
        <span className="text-xs font-medium text-text">{data.label}</span>
      </div>
      <div className="mono mt-0.5 flex gap-2 text-2xs text-text-faint">
        <span>{data.status === "HEALTHY" ? "ok" : data.status.replace(/_/g, " ").toLowerCase()}</span>
        <span>cpu {Math.round(data.cpu)}%</span>
        <span>{Math.round(data.latencyMs)}ms</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { service: ServiceNode };

/** Topology of the simulated range. Node status/metrics come from InfrastructureNode rows. */
export function NetworkGraph({ nodes: infra, className }: { nodes: InfraNode[]; className?: string }) {
  const nodes: Node[] = useMemo(
    () => infra.map((n) => ({ id: n.key, type: "service", position: { x: n.posX, y: n.posY }, data: n, draggable: true })),
    [infra],
  );
  const byKey = new Set(infra.map((n) => n.key));
  const edges: Edge[] = EDGES.filter(([a, b]) => byKey.has(a) && byKey.has(b)).map(([a, b]) => {
    const attacked = infra.find((n) => n.key === b)?.status === "UNDER_ATTACK";
    return { id: `${a}-${b}`, source: a, target: b, animated: attacked, style: { stroke: attacked ? palette.danger : palette.border.strong, strokeWidth: attacked ? 1.5 : 1 } };
  });

  return (
    <div className={className ?? "h-[440px]"} aria-label="Simulated network topology">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15 }} proOptions={{ hideAttribution: true }} nodesConnectable={false} edgesFocusable={false} minZoom={0.4}>
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color={palette.border.DEFAULT} />
      </ReactFlow>
    </div>
  );
}

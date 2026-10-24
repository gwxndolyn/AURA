export interface MissionTask {
  id: string;
  key: string;
  title: string;
  description: string;
  kind: string;
  agentKey: string;
  assignmentReason?: string;
  files?: string[];
  tools: string[];
  dependsOn: string[];
  acceptance: string[];
  required: boolean;
  status: string;
  verification: "NONE" | "PASSED" | "FAILED" | "UNVERIFIED";
  attempts: number;
  maxAttempts: number;
  output: string;
  errorCategory: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MissionArtifact {
  id: string;
  taskKey: string | null;
  kind: "TEST_REPORT" | "DIFF" | "FILE" | "ANALYSIS" | "SECURITY_REPORT" | string;
  name: string;
  version: number;
  content: string;
  meta: Record<string, any>;
  createdAt: string;
}

export interface MissionApproval {
  id: string;
  taskKey: string | null;
  action: string;
  reason: string;
  impact: string;
  risk: string;
  onApprove: string;
  onReject: string;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string;
  createdAt: string;
}

export interface MissionPlan {
  id: string;
  version: number;
  summary: string;
  risks: string[];
  estimatedCostUsd: number;
  estimatedMinutes: number;
  status: string;
  changeReason: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface MissionDetail {
  id: string;
  title: string;
  objective: string;
  template: string | null;
  source: "USER" | "EXAMPLE" | "SEEDED";
  status: string;
  statusHelp: string;
  statusReason: string;
  acceptance: string[];
  budgetUsd: number;
  costUsd: number;
  modelCalls: number;
  toolCalls: number;
  planVersion: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  plans: MissionPlan[];
  tasks: MissionTask[];
  levels: string[][];
  artifacts: MissionArtifact[];
  approvals: MissionApproval[];
  findings?: { code: string; source: string; severity: string; blocking: boolean; title: string; status: string; supported: boolean }[];
  risk?: string;
  repairRounds?: number;
  maxRepairs?: number;
}

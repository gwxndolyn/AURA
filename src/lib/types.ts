// Shared enums/consts enforced in app code (SQLite stores them as String).

export const AGENT_STATUSES = [
  "IDLE",
  "THINKING",
  "WORKING",
  "WAITING",
  "BLOCKED",
  "FAILED",
  "COMPLETED",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const COMPANY_STATUSES = [
  "BUILDING",
  "OPERATING",
  "INCIDENT",
  "UNDER_ATTACK",
  "RECOVERING",
] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const TASK_STATUSES = [
  "BACKLOG",
  "PLANNED",
  "IN_PROGRESS",
  "REVIEW",
  "TESTING",
  "DONE",
  "BLOCKED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const AUTONOMY_LEVELS = ["ASSISTED", "BALANCED", "AUTONOMOUS"] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

export const MODEL_TIERS = ["FAST", "STANDARD", "REASONING"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export type EventType =
  | "AGENT_STARTED"
  | "AGENT_THINKING"
  | "AGENT_TOOL_CALL"
  | "AGENT_COMPLETED"
  | "AGENT_FAILED"
  | "TASK_CREATED"
  | "TASK_UPDATED"
  | "CODE_CHANGED"
  | "TEST_STARTED"
  | "TEST_COMPLETED"
  | "DEPLOYMENT_STARTED"
  | "DEPLOYMENT_COMPLETED"
  | "ATTACK_STARTED"
  | "ATTACK_DETECTED"
  | "INCIDENT_CREATED"
  | "INCIDENT_RESOLVED"
  | "VULNERABILITY_FOUND"
  | "VULNERABILITY_PATCHED"
  | "SIM_TICK"
  | "COMPANY_UPDATED"
  | "DECISION_CREATED"
  | "CHAT"
  | "EVALUATION_COMPLETED"
  | "PROMPT_PROMOTED"
  | "MISSION_UPDATED"
  | "OPS_FINDING"
  | "OPS_ACTION"
  | "OPS_MONITOR"
  | "PRODUCT_UPDATED"
  | "LAB_EXPERIMENT";

export interface LiveEvent {
  id: string;
  companyId: string;
  type: EventType;
  actor?: string;
  actorName?: string;
  role?: string;
  message: string;
  level: "info" | "success" | "warning" | "danger";
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface AcceptanceCriterion {
  text: string;
  met: boolean;
}

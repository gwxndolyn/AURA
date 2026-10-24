/**
 * Test-only fault injection for the mission engine.
 *
 * Lets the failure-mode tests make a model return malformed/refusing output,
 * make a tool hang or error, take the sandbox "down", or run a hook mid-step
 * (e.g. a cancellation). Faults are consulted only when NODE_ENV === "test";
 * `injectFault` throws in any other environment, so production behaviour can
 * never be altered through this module.
 */

export type FaultSpec =
  | { point: "model"; mode: "malformed" | "refusal" | "unexpected"; times?: number }
  | { point: "tool"; tool: string; mode: "timeout" | "error" | "malformed"; times?: number }
  | { point: "docker"; times?: number }
  | { point: "candidate"; code: string; times?: number }
  | { point: "afterExecute"; fn: () => Promise<void>; times?: number };

type Point = FaultSpec["point"];

const registry = new Map<string, (FaultSpec & { remaining: number })[]>();
const keyOf = (missionId: string, taskKey: string) => `${missionId}::${taskKey}`;
const enabled = () => process.env.NODE_ENV === "test";

export function injectFault(missionId: string, taskKey: string, spec: FaultSpec) {
  if (!enabled()) throw new Error("Fault injection is only available in tests");
  const k = keyOf(missionId, taskKey);
  registry.set(k, [...(registry.get(k) ?? []), { ...spec, remaining: spec.times ?? 1 }]);
}

export function clearFaults() {
  registry.clear();
}

/** Consume one matching fault, if any. */
export function takeFault<P extends Point>(missionId: string, taskKey: string, point: P, tool?: string): Extract<FaultSpec, { point: P }> | undefined {
  if (!enabled()) return undefined;
  const list = registry.get(keyOf(missionId, taskKey));
  const f = list?.find((x) => x.point === point && x.remaining > 0 && (point !== "tool" || (x as { tool?: string }).tool === tool));
  if (!f) return undefined;
  f.remaining--;
  return f as unknown as Extract<FaultSpec, { point: P }>;
}

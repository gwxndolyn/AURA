/**
 * Simulation lab: AURA's earlier company-simulator surfaces (sim clock,
 * fictional finance and customers, cyber range, simulated deploy pipeline,
 * company twin). Off by default; enable for research/demos with
 * AURA_SIMULATION_LAB=1 (server) and NEXT_PUBLIC_AURA_SIMULATION_LAB=1 (UI).
 * Customer-facing product flows never depend on it.
 */
export function labEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AURA_SIMULATION_LAB === "1" || process.env.AURA_SIMULATION_LAB === "1";
}

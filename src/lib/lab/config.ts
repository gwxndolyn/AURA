/**
 * Pipeline configurations the lab can evaluate. A configuration names the
 * versioned engineering methods under test; the builder engine reads the same
 * knobs (AURA_GATE_POLICY, AURA_CONTEXT_STRATEGY) so an accepted
 * configuration can become the engine default without translation.
 */
import { DEFAULT_GATE_POLICY, GATE_POLICIES } from "@/lib/builder/verdict";
import { DEFAULT_CONTEXT_STRATEGY, CONTEXT_STRATEGIES } from "@/lib/builder/intel";
import { DEFAULT_CLASSIFIER, CLASSIFIER_VERSIONS } from "@/lib/builder/debug";

export interface LabConfig { key: string; gatePolicy: string; contextStrategy: string; classifier: string }

export const DEFAULT_CONFIG: LabConfig = { key: "default", gatePolicy: DEFAULT_GATE_POLICY, contextStrategy: DEFAULT_CONTEXT_STRATEGY, classifier: DEFAULT_CLASSIFIER };

/** Parse "gate=v2,context=graph" (or a bare key "default"). Unknown values are refused. */
export function resolveConfig(spec: string): LabConfig {
  if (!spec || spec === "default") return DEFAULT_CONFIG;
  const cfg: LabConfig = { ...DEFAULT_CONFIG, key: spec };
  for (const part of spec.split(",")) {
    const [k, v] = part.split("=");
    if (k === "gate") {
      if (!GATE_POLICIES[v]) throw new Error(`unknown gate policy ${v}`);
      cfg.gatePolicy = v;
    } else if (k === "context") {
      if (!(CONTEXT_STRATEGIES as readonly string[]).includes(v)) throw new Error(`unknown context strategy ${v}`);
      cfg.contextStrategy = v;
    } else if (k === "diagnose") {
      if (!(CLASSIFIER_VERSIONS as readonly string[]).includes(v)) throw new Error(`unknown classifier ${v}`);
      cfg.classifier = v;
    } else throw new Error(`unknown config key ${k}`);
  }
  return cfg;
}

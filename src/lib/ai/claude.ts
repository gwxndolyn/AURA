import Anthropic from "@anthropic-ai/sdk";
import type { ModelTier } from "@/lib/types";
import { estimateCost } from "./pricing";
import { simulatedCompletion } from "./simulator";

/**
 * Centralized Claude AI service abstraction. ALL model calls go through here.
 *
 * - Routes tasks to models by tier via environment variables.
 * - Tracks token usage, cost and latency.
 * - Falls back to a deterministic local reasoning engine ("SIMULATION mode")
 *   when ANTHROPIC_API_KEY is not configured, so the entire app is fully
 *   functional offline. When a key is present, real Claude calls are made.
 */

export const MODELS: Record<ModelTier, string> = {
  FAST: process.env.CLAUDE_MODEL_FAST || "claude-haiku-4-5-20251001",
  STANDARD: process.env.CLAUDE_MODEL_STANDARD || "claude-sonnet-5-5",
  REASONING: process.env.CLAUDE_MODEL_REASONING || "claude-opus-5-5",
};

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}

/**
 * The deterministic simulator may only stand in for a model in the simulation
 * lab (AURA_SIMULATION_LAB=1, legacy company-simulator surfaces) and in the
 * automated test environment. In every other environment a missing key or a
 * provider failure is reported as a ProviderError — never replaced by
 * fabricated output.
 */
export function simulationAllowed(): boolean {
  return process.env.AURA_SIMULATION_LAB === "1" || process.env.NODE_ENV === "test";
}

export function aiMode(): "live" | "simulation" {
  return hasApiKey() ? "live" : "simulation";
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    // ANTHROPIC_BASE_URL (optional) points at a gateway/proxy; the SDK default is api.anthropic.com.
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.ANTHROPIC_BASE_URL || undefined, maxRetries: 2, timeout: Number(process.env.AURA_MODEL_TIMEOUT_MS || 120_000) });
  }
  return client;
}

/** Test hook: drop the cached client so env changes (base URL / key) take effect. */
export function resetClientForTests() {
  client = null;
}

export type ProviderErrorKind = "not_configured" | "rate_limited" | "overloaded" | "timeout" | "auth" | "bad_request" | "unavailable";

/**
 * Raised by strict calls instead of substituting simulated output. `retryable`
 * tells durable jobs whether backing off and retrying can help.
 */
export class ProviderError extends Error {
  constructor(public kind: ProviderErrorKind, message: string, public retryable: boolean) {
    super(message);
    this.name = "ProviderError";
  }
}

function classifyProviderError(err: unknown): ProviderError {
  const e = err as { status?: number; name?: string; message?: string };
  const msg = (e.message ?? "provider error").slice(0, 300);
  if (e.status === 401 || e.status === 403) return new ProviderError("auth", `Model provider rejected the credentials (${e.status})`, false);
  if (e.status === 429) return new ProviderError("rate_limited", "Model provider rate limit reached", true);
  if (e.status === 529 || e.status === 503) return new ProviderError("overloaded", "Model provider is overloaded", true);
  if (e.status === 400 || e.status === 404 || e.status === 422) return new ProviderError("bad_request", `Model provider refused the request: ${msg}`, false);
  if (/timeout|timed out|ETIMEDOUT/i.test(e.name ?? "") || /timeout|timed out/i.test(msg)) return new ProviderError("timeout", "Model provider timed out", true);
  return new ProviderError("unavailable", `Model provider unavailable: ${msg}`, true);
}

export interface CompleteParams {
  tier: ModelTier;
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Deterministic seed used by the simulation engine when no API key. */
  seed?: string;
  /** Hint for the simulator about what kind of output is expected. */
  kind?: string;
  /**
   * Strict: never substitute simulated output. Throws ProviderError when no key
   * is configured or the provider fails. Customer-facing product flows use this.
   */
  strict?: boolean;
}

export interface CompletionResult {
  text: string;
  model: string;
  tier: ModelTier;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  latencyMs: number;
  mode: "live" | "simulation";
  /** Prompt-cache usage as reported by the provider (0 when not reported). */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** "provider" = counts from the API response; "estimated" = chars/4 estimate (simulator or fallback). */
  usageSource: "provider" | "estimated";
  /** Why the provider path was not used, when it wasn't (no key / API error). */
  fallbackReason?: string;
}

/** Rough token estimate (chars/4) used for the simulation path. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

export async function complete(params: CompleteParams): Promise<CompletionResult> {
  const { tier, system, prompt, maxTokens = 1024, temperature = 0.7 } = params;
  const model = MODELS[tier];
  const start = Date.now();

  const strict = params.strict ?? !simulationAllowed();
  if (!hasApiKey() && strict) throw new ProviderError("not_configured", "No AI provider is configured (set ANTHROPIC_API_KEY on the server)", false);
  if (!hasApiKey()) {
    const sim = simulatedCompletion({
      system,
      prompt,
      kind: params.kind,
      seed: params.seed,
    });
    const tokensIn = estimateTokens(system + prompt);
    const tokensOut = estimateTokens(sim);
    // Small artificial latency so the UI shows realistic "thinking".
    await new Promise((r) => setTimeout(r, 120 + Math.min(400, tokensOut / 4)));
    return {
      text: sim,
      model: `${model} (sim)`,
      tier,
      tokensIn,
      tokensOut,
      cost: estimateCost(model, tokensIn, tokensOut),
      latencyMs: Date.now() - start,
      mode: "simulation",
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageSource: "estimated",
      fallbackReason: "no API key",
    };
  }

  try {
    const resp = await getClient().messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const tokensIn = resp.usage.input_tokens;
    const tokensOut = resp.usage.output_tokens;
    // Cache fields are returned by the API but not declared by this SDK version.
    const u = resp.usage as unknown as { cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    return {
      text,
      model,
      tier,
      tokensIn,
      tokensOut,
      cost: estimateCost(model, tokensIn, tokensOut),
      latencyMs: Date.now() - start,
      mode: "live",
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      usageSource: "provider",
    };
  } catch (err) {
    if (strict) throw classifyProviderError(err);
    // Legacy simulator surfaces only: degrade to the labelled simulator instead of crashing.
    const sim = simulatedCompletion({
      system,
      prompt,
      kind: params.kind,
      seed: params.seed,
    });
    const tokensIn = estimateTokens(system + prompt);
    const tokensOut = estimateTokens(sim);
    return {
      text: sim,
      model: `${model} (fallback)`,
      tier,
      tokensIn,
      tokensOut,
      cost: estimateCost(model, tokensIn, tokensOut),
      latencyMs: Date.now() - start,
      mode: "simulation",
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageSource: "estimated",
      fallbackReason: `provider error: ${(err as Error).message?.slice(0, 200) ?? "unknown"}`,
    };
  }
}


// ---------------------------------------------------------------------------
// Tool-using conversation (agentic loop). Strict only: there is no simulated
// substitute for real tool use. The caller executes tools (through callTool)
// and feeds results back; every turn's usage is accumulated.
// ---------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ConverseResult {
  text: string;
  model: string;
  tier: ModelTier;
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  latencyMs: number;
  stopReason: "end_turn" | "max_turns" | "budget" | "cancelled";
}

export async function converse(params: {
  tier: ModelTier;
  system: string;
  prompt: string;
  tools: ToolDef[];
  /** Executes one tool call; return value is sent back as the tool_result (stringified). Throwing reports an error result to the model. */
  onTool: (use: ToolUse) => Promise<unknown>;
  maxTurns?: number;
  maxTokens?: number;
  /** Stop before the next model call when this returns a reason (budget, cancellation). */
  shouldStop?: (usage: { cost: number; turns: number }) => Promise<"budget" | "cancelled" | null>;
}): Promise<ConverseResult> {
  if (!hasApiKey()) throw new ProviderError("not_configured", "No AI provider is configured (set ANTHROPIC_API_KEY on the server)", false);
  const model = MODELS[params.tier];
  const start = Date.now();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: params.prompt }];
  const out: ConverseResult = { text: "", model, tier: params.tier, turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, cost: 0, latencyMs: 0, stopReason: "end_turn" };
  const maxTurns = Math.min(Math.max(params.maxTurns ?? 20, 1), 60);
  for (;;) {
    if (out.turns >= maxTurns) {
      out.stopReason = "max_turns";
      break;
    }
    const stop = await params.shouldStop?.({ cost: out.cost, turns: out.turns });
    if (stop) {
      out.stopReason = stop;
      break;
    }
    let resp: Anthropic.Message;
    try {
      resp = await getClient().messages.create({ model, max_tokens: params.maxTokens ?? 4096, system: params.system, tools: params.tools as Anthropic.Tool[], messages });
    } catch (err) {
      throw classifyProviderError(err);
    }
    out.turns++;
    out.tokensIn += resp.usage.input_tokens;
    out.tokensOut += resp.usage.output_tokens;
    out.cost += estimateCost(model, resp.usage.input_tokens, resp.usage.output_tokens);
    const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
    if (text) out.text = text;
    const uses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (resp.stop_reason !== "tool_use" || !uses.length) break;
    messages.push({ role: "assistant", content: resp.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      out.toolCalls++;
      try {
        const r = await params.onTool({ id: u.id, name: u.name, input: (u.input ?? {}) as Record<string, unknown> });
        results.push({ type: "tool_result", tool_use_id: u.id, content: (typeof r === "string" ? r : JSON.stringify(r)).slice(0, 60_000) });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: u.id, content: `ERROR: ${(e as Error).message}`.slice(0, 4000), is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  out.latencyMs = Date.now() - start;
  return out;
}

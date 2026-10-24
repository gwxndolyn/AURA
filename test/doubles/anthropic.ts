/**
 * TEST DOUBLE — Anthropic Messages API over HTTP, for automated tests ONLY.
 *
 * The application talks to it through the real Anthropic SDK by setting
 * ANTHROPIC_BASE_URL. It does not validate model quality: each scenario
 * scripts what a model would answer (plans as JSON, tool_use blocks that the
 * app then REALLY executes against the working tree and sandbox). This keeps
 * CI free of paid model calls while every other layer — SDK, tool loop,
 * callTool authorization, git, Docker, verification — runs for real.
 */
import http from "node:http";
import { AddressInfo } from "node:net";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type Responder = (req: { system: string; messages: { role: string; content: unknown }[]; tools: { name: string }[] }) => Block[] | { error: number };

export interface Double {
  url: string;
  calls: { system: string; lastUser: string }[];
  setResponder(fn: Responder): void;
  close(): Promise<void>;
}

let seq = 0;
export const text = (t: string): Block => ({ type: "text", text: t });
export const tool = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: `toolu_${++seq}`, name, input });

/** The text of the last user turn (string or tool_result blocks). */
export function lastUserText(messages: { role: string; content: unknown }[]) {
  const m = [...messages].reverse().find((x) => x.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content as { type: string; content?: string; text?: string }[]).map((b) => b.content ?? b.text ?? "").join("\n");
}

export async function startAnthropicDouble(initial: Responder): Promise<Double> {
  let responder = initial;
  const calls: Double["calls"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!req.url?.startsWith("/v1/messages")) {
        res.writeHead(404).end();
        return;
      }
      const j = JSON.parse(body || "{}");
      const system = typeof j.system === "string" ? j.system : JSON.stringify(j.system ?? "");
      calls.push({ system, lastUser: lastUserText(j.messages ?? []) });
      const out = responder({ system, messages: j.messages ?? [], tools: j.tools ?? [] });
      if ("error" in out) {
        res.writeHead(out.error, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: out.error === 429 ? "rate_limit_error" : "api_error", message: "test double error" } }));
        return;
      }
      const usesTool = out.some((b) => b.type === "tool_use");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `msg_${++seq}`, type: "message", role: "assistant", model: j.model, content: out, stop_reason: usesTool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: Math.ceil(body.length / 4), output_tokens: Math.ceil(JSON.stringify(out).length / 4) } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, setResponder: (fn) => (responder = fn), close: () => new Promise((r) => server.close(() => r())) };
}

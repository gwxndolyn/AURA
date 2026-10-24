"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Send, X } from "lucide-react";
import { useMutation } from "@/hooks/useApi";
import { AgentAvatar } from "@/components/ui/primitives";
import { getAgentDef } from "@/lib/agents/definitions";
import { palette } from "@/lib/theme";

const CEO_COLOR = getAgentDef("ceo")?.color ?? palette.text.muted;

const SUGGESTIONS = [
  "How is the company doing?",
  "What's our biggest technical risk?",
  "What should we work on next?",
  "Why might revenue change?",
];

interface Msg {
  role: "user" | "ceo";
  text: string;
}

export function CeoDialog({
  companyId,
  open,
  onClose,
}: {
  companyId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { mutate, loading } = useMutation<{ question: string }, { answer: string }>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function ask(q: string) {
    if (!q.trim()) return;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    try {
      const res = await mutate(`/api/companies/${companyId}/ceo`, { question: q });
      setMessages((m) => [...m, { role: "ceo", text: res.answer }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "ceo", text: `Request failed: ${(e as Error).message}` }]);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ y: 6, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 6, opacity: 0 }}
            transition={{ duration: 0.14 }}
            role="dialog"
            aria-modal="true"
            aria-label="Ask the CEO agent"
            className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-border-strong bg-bg-raised shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2.5">
                <AgentAvatar avatar="AD" color={CEO_COLOR} size={28} />
                <div>
                  <div className="text-sm font-medium">Ada · AI CEO</div>
                  <div className="text-2xs text-text-faint">Answers from the current company snapshot</div>
                </div>
              </div>
              <button onClick={onClose} className="icon-btn" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px]">
              {messages.length === 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-text-muted">Ask the AI CEO anything about the company.</p>
                  <div className="flex flex-wrap gap-1.5">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => ask(s)}
                        className="h-7 rounded-md border border-border px-2.5 text-xs text-text-muted hover:border-border-strong hover:text-text"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex gap-2"}>
                  {m.role === "ceo" && <AgentAvatar avatar="AD" color={CEO_COLOR} size={22} />}
                  <div
                    className={`rounded-lg px-3 py-2 text-sm max-w-[80%] ${
                      m.role === "user" ? "bg-bg-hover text-text" : "border border-border bg-bg-elevated"
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex gap-2 items-center text-text-faint text-sm">
                  <AgentAvatar avatar="AD" color={CEO_COLOR} size={22} active />
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Ada is analyzing company state…
                </div>
              )}
            </div>

            <div className="p-3 border-t border-border flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ask(input)}
                placeholder="Ask the CEO…"
                className="input"
              />
              <button onClick={() => ask(input)} disabled={loading || !input.trim()} className="btn-secondary" aria-label="Send question">
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

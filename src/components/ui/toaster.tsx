"use client";

import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from "lucide-react";
import { useApp } from "@/lib/store";

const ICONS = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle };
const COLORS = { info: "text-info", success: "text-success", warning: "text-warning", danger: "text-danger" };

export function Toaster() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICONS[t.level];
          return (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
              role={t.level === "danger" ? "alert" : "status"}
              className="flex items-start gap-2.5 rounded-lg border border-border-strong bg-bg-elevated px-3 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${COLORS[t.level]}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t.title}</div>
                {t.description && <div className="mt-0.5 break-words text-xs text-text-muted">{t.description}</div>}
              </div>
              <button onClick={() => dismiss(t.id)} className="icon-btn -mr-1 -mt-0.5 h-6 w-6" aria-label="Dismiss notification">
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

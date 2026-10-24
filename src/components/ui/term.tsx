"use client";

import { useId, useState } from "react";
import { GLOSSARY, GLOSSARY_LABEL, type GlossaryKey } from "@/lib/glossary";
import { cn } from "@/lib/utils";

/**
 * A glossary term: dotted underline, definition on hover or keyboard focus.
 * Accessible (aria-describedby, Escape closes), no library.
 */
export function Term({ k, children, className }: { k: GlossaryKey; children?: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-block" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        className={cn("cursor-help underline decoration-text-faint decoration-dotted underline-offset-[3px] hover:decoration-text-muted", className)}
      >
        {children ?? GLOSSARY_LABEL[k]}
      </button>
      {open && (
        <span role="tooltip" id={id} className="absolute left-0 top-full z-50 mt-1.5 block w-72 rounded-md border border-border-strong bg-bg-elevated px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-text-muted shadow-lg">
          <span className="mb-0.5 block font-medium text-text">{GLOSSARY_LABEL[k]}</span>
          {GLOSSARY[k]}
        </span>
      )}
    </span>
  );
}

/** Action consequence markers: reversible? uses the model? needs approval? */
export function ActionFacts({ reversible, model, approval }: { reversible?: boolean; model?: boolean; approval?: boolean }) {
  const facts: string[] = [];
  if (reversible !== undefined) facts.push(reversible ? "reversible" : "not reversible");
  if (model) facts.push("uses model calls");
  if (approval) facts.push("needs approval");
  return <span className="mono text-2xs text-text-faint">{facts.join(" · ")}</span>;
}

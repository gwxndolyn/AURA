"use client";

import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Read-only code viewer with line numbers, copy, and a small dependency-free
 * highlighter for JS/TS/JSON/Markdown. It colors only comments, strings,
 * numbers and keywords — enough to aid scanning without a heavy library.
 */

const KEYWORDS = new Set(
  "const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of null undefined true false this interface type enum implements public private protected readonly static".split(" "),
);

type Tok = { t: string; k?: "c" | "s" | "n" | "k" | "h" };

function tokenizeLine(line: string, lang: string): Tok[] {
  if (lang === "md") {
    if (/^\s*#/.test(line)) return [{ t: line, k: "h" }];
    return [{ t: line }];
  }
  const out: Tok[] = [];
  const re = /(\/\/.*$|#.*$|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ t: line.slice(last, m.index) });
    const s = m[0];
    if (s.startsWith("//") || s.startsWith("/*") || (s.startsWith("#") && lang !== "json")) out.push({ t: s, k: "c" });
    else if (/^["'`]/.test(s)) out.push({ t: s, k: "s" });
    else if (/^\d/.test(s)) out.push({ t: s, k: "n" });
    else if (KEYWORDS.has(s)) out.push({ t: s, k: "k" });
    else out.push({ t: s });
    last = m.index + s.length;
  }
  if (last < line.length) out.push({ t: line.slice(last) });
  return out;
}

const TOK_CLASS: Record<string, string> = {
  c: "text-text-faint italic",
  s: "text-success",
  n: "text-warning",
  k: "text-info",
  h: "text-text font-semibold",
};

export function langOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "js";
  if (ext === "json") return "json";
  if (ext === "md") return "md";
  return "text";
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="btn-ghost btn-sm"
      aria-label={label}
    >
      {done ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      {done ? "Copied" : label}
    </button>
  );
}

export function CodeView({ code, path, className }: { code: string; path: string; className?: string }) {
  const lang = langOf(path);
  const lines = useMemo(() => code.replace(/\n$/, "").split("\n"), [code]);
  const gutter = String(lines.length).length;
  return (
    <div className={cn("mono overflow-auto text-xs leading-[1.6]", className)} role="region" aria-label={`Contents of ${path}`}>
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className="hover:bg-bg-elevated/60">
              <td className="select-none whitespace-nowrap py-0 pl-3 pr-4 text-right align-top text-text-faint/70" style={{ width: `${gutter + 3}ch` }}>
                {i + 1}
              </td>
              <td className="whitespace-pre py-0 pr-4 text-text">
                {lang === "text" ? line || " " : tokenizeLine(line, lang).map((tk, j) => <span key={j} className={tk.k ? TOK_CLASS[tk.k] : undefined}>{tk.t}</span>)}
                {line === "" && " "}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

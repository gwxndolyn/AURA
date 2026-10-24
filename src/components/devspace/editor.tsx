"use client";

import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { palette } from "@/lib/theme";

/** Language support by file extension (only languages whose packages are installed). */
export function languageFor(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return javascript({ jsx: ext === "jsx" });
  if (["ts", "tsx"].includes(ext)) return javascript({ typescript: true, jsx: ext === "tsx" });
  if (ext === "json") return json();
  if (ext === "md") return markdown();
  return [];
}

/** AURA dark theme mapped onto the design tokens. */
const auraTheme = EditorView.theme(
  {
    "&": { color: palette.text.DEFAULT, backgroundColor: palette.bg.inset, height: "100%", fontSize: "12.5px" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
    ".cm-content": { caretColor: palette.brand.DEFAULT },
    ".cm-gutters": { backgroundColor: palette.bg.inset, color: palette.text.faint, border: "none", borderRight: `1px solid ${palette.border.subtle}` },
    ".cm-activeLine": { backgroundColor: "#ffffff06" },
    ".cm-activeLineGutter": { backgroundColor: "#ffffff08", color: palette.text.muted },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#c5f04a33 !important" },
    ".cm-searchMatch": { backgroundColor: "#e5a13b44", outline: "1px solid #e5a13b88" },
    ".cm-panels": { backgroundColor: palette.bg.raised, color: palette.text.DEFAULT, borderTop: `1px solid ${palette.border.DEFAULT}` },
    ".cm-panels input, .cm-panels button": { fontSize: "12px" },
    ".cm-textfield": { backgroundColor: palette.bg.inset, border: `1px solid ${palette.border.strong}`, color: palette.text.DEFAULT },
    ".cm-button": { backgroundImage: "none", backgroundColor: palette.bg.elevated, border: `1px solid ${palette.border.strong}`, color: palette.text.DEFAULT },
    ".cm-changedLine": { backgroundColor: "#4cc38a14 !important" },
    ".cm-deletedChunk": { backgroundColor: "#ef5d5d14 !important" },
    ".cm-changedText": { background: "#4cc38a40 !important" },
    ".cm-deletedText, .cm-deletedChunk del": { background: "#ef5d5d40 !important", textDecoration: "none" },
    ".cm-merge-a .cm-changedLine": { backgroundColor: "#ef5d5d14 !important" },
    ".cm-merge-a .cm-changedText": { background: "#ef5d5d40 !important" },
    ".cm-collapsedLines": { backgroundColor: palette.bg.raised, color: palette.text.faint },
  },
  { dark: true },
);

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: palette.info },
    { tag: [t.string, t.special(t.string), t.regexp], color: palette.success },
    { tag: [t.number, t.bool, t.null], color: palette.warning },
    { tag: [t.comment, t.lineComment, t.blockComment], color: palette.text.faint, fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: palette.brand.glow },
    { tag: [t.heading], color: palette.text.DEFAULT, fontWeight: "600" },
  ]),
);

/**
 * CodeMirror 6 editor. Content changes are reported up; the parent owns dirty
 * state and saving. `readOnly` makes it a pure inspector (search and copy still work).
 */
export function CodeEditor({ path, value, readOnly, onChange, onSave }: { path: string; value: string; readOnly: boolean; onChange: (v: string) => void; onSave?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const ro = useRef(new Compartment());
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          languageFor(path),
          auraTheme,
          highlight,
          ro.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave?.(), true) }]),
          EditorView.updateListener.of((u) => u.docChanged && cb.current.onChange(u.state.doc.toString())),
          EditorView.contentAttributes.of({ "aria-label": `Editor: ${path}` }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // A new path gets a fresh editor (own undo history).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // External value changes (reload after save/conflict) replace the doc without remounting.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-testid="code-editor" />;
}

/** Read-only diff: unified (inline) or side-by-side, both via @codemirror/merge. */
export function DiffEditor({ path, before, after, mode }: { path: string; before: string; after: string; mode: "inline" | "split" }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const common = [basicSetup, languageFor(path), auraTheme, highlight, EditorState.readOnly.of(true), EditorView.editable.of(false)];
    if (mode === "split") {
      const mv = new MergeView({ parent: host.current, a: { doc: before, extensions: common }, b: { doc: after, extensions: common }, collapseUnchanged: { margin: 3, minSize: 6 }, gutter: true });
      return () => mv.destroy();
    }
    const v = new EditorView({ parent: host.current, state: EditorState.create({ doc: after, extensions: [...common, unifiedMergeView({ original: before, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 6 } })] }) });
    return () => v.destroy();
  }, [path, before, after, mode]);
  // MergeView is not scrollable by default; give it the container's height and let it scroll.
  return <div ref={host} className="h-full min-h-0 overflow-hidden [&>.cm-editor]:h-full [&_.cm-mergeView]:h-full [&_.cm-mergeView]:overflow-auto [&_.cm-mergeViewEditors]:min-h-full" data-testid="diff-editor" />;
}

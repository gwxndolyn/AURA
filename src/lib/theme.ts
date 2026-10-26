/**
 * AURA design tokens — the single source of truth for color.
 *
 * Imported by tailwind.config.ts (utility classes) AND by code that needs raw
 * values (Recharts strokes, React Flow nodes). Never hardcode hex elsewhere.
 *
 * Palette intent: warm near-black neutrals, one restrained accent ("signal"
 * lime) reserved for primary actions, focus and live/active state, plus
 * semantic colors that only ever carry meaning.
 */
export const palette = {
  bg: {
    DEFAULT: "#0b0b0c", // app canvas
    raised: "#111113", // sidebar, panels
    elevated: "#18181b", // inputs, popovers, hover rows
    hover: "#1d1d21",
    inset: "#08080a", // code / log wells
  },
  border: {
    DEFAULT: "#232327",
    strong: "#303035",
    subtle: "#1a1a1d",
  },
  text: {
    DEFAULT: "#ecebe6", // warm off-white
    muted: "#a3a29c",
    faint: "#8f8e88", // ≥ 4.5:1 (WCAG AA) on every surface incl. bg.hover; was #6e6d68 (3.2–3.8:1, flagged by AURA's own experience audit)
  },
  // Accent. Named `brand` so existing utilities keep working.
  brand: {
    DEFAULT: "#c5f04a",
    dim: "#8fb32a",
    glow: "#d6f77a", // lighter tint for text on dark surfaces
    ink: "#0d1003", // text color on top of the accent
  },
  success: "#4cc38a",
  warning: "#e5a13b",
  danger: "#ef5d5d",
  info: "#78a9ff",
} as const;

/**
 * Chart colors. Categorical series are assigned in this fixed order (never
 * cycled). Steps sit in the dark-mode lightness band (OKLCH L 0.48–0.67) and
 * pass the dataviz validator against bg.raised: CVD ΔE ≥ 8, normal ≥ 15,
 * contrast ≥ 3:1. Re-run the validator if you change them.
 */
export const chart = {
  grid: palette.border.subtle,
  axis: palette.text.faint,
  series: ["#4f86e8", "#c6831f", "#2fa36e", "#9a6ae0", "#d24f63"],
} as const;

export const severityColor: Record<string, string> = {
  LOW: palette.text.muted,
  MEDIUM: palette.info,
  HIGH: palette.warning,
  CRITICAL: palette.danger,
};

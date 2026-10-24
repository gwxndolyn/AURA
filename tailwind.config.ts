import type { Config } from "tailwindcss";
import { palette } from "./src/lib/theme";

/**
 * Tailwind is driven entirely by the tokens in src/lib/theme.ts. The type
 * scale is deliberately compact (13px body) for a dense engineering tool.
 */
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        bg: palette.bg,
        border: palette.border,
        text: palette.text,
        brand: palette.brand,
        danger: palette.danger,
        success: palette.success,
        warning: palette.warning,
        info: palette.info,
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        "2xs": ["10.5px", { lineHeight: "14px" }],
        xs: ["12px", { lineHeight: "16px" }],
        sm: ["13px", { lineHeight: "19px" }],
        base: ["14px", { lineHeight: "21px" }],
        lg: ["16px", { lineHeight: "22px" }],
        xl: ["18px", { lineHeight: "24px" }],
        "2xl": ["20px", { lineHeight: "26px" }],
        "3xl": ["26px", { lineHeight: "32px" }],
        "4xl": ["34px", { lineHeight: "38px" }],
        "5xl": ["44px", { lineHeight: "48px" }],
        "6xl": ["54px", { lineHeight: "56px" }],
      },
      borderRadius: {
        DEFAULT: "4px",
        md: "5px",
        lg: "7px",
        xl: "9px",
      },
      transitionDuration: { DEFAULT: "140ms" },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(2px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
        "live-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out",
        shimmer: "shimmer 1.6s infinite",
        "live-dot": "live-dot 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;

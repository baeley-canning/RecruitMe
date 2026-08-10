import type { Config } from "tailwindcss";

/**
 * Logic Pro / Pro Apps design tokens for RecruitMe.
 *
 * Aesthetic: dark, dense, professional. Surfaces stay flat; depth comes
 * from background tone differences (#0c, #14, #1c, #24, #2c) rather than
 * shadows. SF Pro for UI text, SF Mono for data/scores/IDs.
 *
 * Token names mirror Apple's macOS HIG so values feel familiar:
 *   - surface-{base, raised, overlay, hover}  background layers
 *   - separator                                hairline borders (≈ rgba 0.08)
 *   - text-{primary, secondary, tertiary}      foreground tiers
 *   - accent / success / warning / danger / llama
 *
 * Components import these via Tailwind utility classes (bg-surface-base,
 * text-text-primary, border-separator, etc.) — DO NOT hardcode hex values
 * inside components or the dark theme will drift.
 */
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          // Outermost shell — what the OS chrome would frame.
          base:    "#212429",
          // Standard card / panel surface.
          raised:  "#2a2e34",
          // Elevated surface (modals, popovers, tooltip backgrounds).
          overlay: "#31363d",
          // Subtle hover lift, also used for inset rows.
          hover:   "#343a42",
          // Hover on top of an already-hovered/inset row (secondary buttons).
          "hover-strong": "#3d444d",
          // Even-more-subtle row-stripe / pressed state.
          sunken:  "#262a2f",
        },
        separator: {
          // Hairline borders — barely visible, just enough to delineate.
          // Slightly stronger than before: on a lifted ground a 0.08 hairline
          // disappears, and structure is doing more work in this design.
          DEFAULT: "rgba(255, 255, 255, 0.10)",
          strong:  "rgba(255, 255, 255, 0.17)",
          subtle:  "rgba(255, 255, 255, 0.06)",
        },
        text: {
          primary:   "#eceef1",  // headlines, key data
          secondary: "#aab1bb",  // body labels, meta
          // Captions/placeholders. The design's own --ink-3 (#7d858f) measures
          // ~4.2:1 on surface-raised, under the AA floor an earlier fix raised
          // this token to clear — so this keeps that cool cast but lightens
          // until it passes: 4.86:1 on raised, 5.54:1 on base.
          tertiary:  "#939ba5",
          // Ink for text sitting ON a solid accent/semantic fill. The accent is
          // now a pale steel blue, so white-on-accent would be ~1.9:1; this dark
          // ink measures 7.3:1 on accent and 5.8–8.0:1 on the semantic fills.
          // Var-driven so a white-label brand colour can supply its own ink.
          inverse:   "rgb(var(--brand-ink-rgb, 18 33 44) / <alpha-value>)",
        },
        accent: {
          // Apple "Blue" system color in dark mode — primary action.
          // Channel-format CSS vars make the accent white-labelable: an org's
          // brand colour overrides --brand-primary-rgb (set by WhiteLabelStyles)
          // while the `<alpha-value>` placeholder keeps every `accent/NN`
          // opacity modifier working. Fallback channels = the default blue, so
          // with white-label off (the default) rendering is byte-identical.
          DEFAULT: "rgb(var(--brand-primary-rgb, 125 179 216) / <alpha-value>)",
          hover:   "rgb(var(--brand-primary-hover-rgb, 154 200 229) / <alpha-value>)",
          subtle:  "rgb(var(--brand-primary-rgb, 125 179 216) / 0.16)",
        },
        // Semantic colours are DESATURATED on purpose. The vivid Apple system
        // greens/reds read as decoration and are the single loudest "generic"
        // signal in a dark UI; muted equivalents let colour mean state without
        // shouting. All still clear AA as text on surface-raised (4.8–6.7:1).
        success: {
          DEFAULT: "#6fc994",
          hover:   "#8ad7ab",
          subtle:  "rgba(111, 201, 148, 0.15)",
        },
        warning: {
          DEFAULT: "#d9a94e",
          hover:   "#e6bd70",
          subtle:  "rgba(217, 169, 78, 0.15)",
        },
        danger: {
          DEFAULT: "#dd7f7f",
          hover:   "#e89a9a",
          subtle:  "rgba(221, 127, 127, 0.15)",
        },
        llama: {
          // Reserved for Llama-failover indicators (banner, badge). Muted
          // violet so it reads as "different mode" without alarm.
          DEFAULT: "#b490dd",
          subtle:  "rgba(180, 144, 221, 0.18)",
        },
        // Source-badge colours (candidateSourceBadge / search-result source
        // pills). Without these tokens the badges fell back to neutral grey —
        // the talent-pool, PDL/API and LinkedIn-in-search pills lost their
        // colour-coding. Apple "Cyan" + "Indigo" so each source stays distinct
        // from accent-blue / success-green / warning-orange.
        info: {
          DEFAULT: "#6fc2c9",
          subtle:  "rgba(111, 194, 201, 0.15)",
        },
        purple: {
          DEFAULT: "#9a95e0",
          subtle:  "rgba(154, 149, 224, 0.18)",
        },
      },
      fontFamily: {
        // -apple-system gives us SF Pro on Apple platforms; system-ui is
        // the universal fallback (Segoe on Windows, Roboto on Android, etc).
        sans: [
          "-apple-system", "BlinkMacSystemFont", "\"SF Pro Text\"",
          "\"SF Pro Display\"", "system-ui", "Inter", "sans-serif",
        ],
        mono: [
          "\"SF Mono\"", "ui-monospace", "Menlo", "Monaco",
          "\"Cascadia Mono\"", "Consolas", "monospace",
        ],
      },
      fontSize: {
        // Apple HIG type scale — tighter than Tailwind defaults.
        "2xs": ["10px", { lineHeight: "12px", letterSpacing: "0.01em" }],
        xs:    ["11px", { lineHeight: "14px" }],
        sm:    ["12px", { lineHeight: "16px" }],
        base:  ["13px", { lineHeight: "18px" }],
        md:    ["14px", { lineHeight: "20px" }],
        lg:    ["17px", { lineHeight: "22px", letterSpacing: "-0.01em" }],
        xl:    ["22px", { lineHeight: "28px", letterSpacing: "-0.015em" }],
        "2xl": ["28px", { lineHeight: "34px", letterSpacing: "-0.02em" }],
      },
      borderRadius: {
        // Smaller radii than current — Apple Pro apps are crisp, not pillowy.
        xs: "3px",
        sm: "5px",
        DEFAULT: "6px",
        md: "8px",
        lg: "10px",
        xl: "12px",
      },
      spacing: {
        // Dense scale — fits more on the screen.
        "0.5": "2px",
        "1.5": "6px",
        "2.5": "10px",
        "3.5": "14px",
      },
      boxShadow: {
        // Shadows are minimal in dark mode — most depth comes from tone.
        "overlay": "0 12px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.06)",
        "popover": "0 6px 18px rgba(0, 0, 0, 0.32), 0 0 0 1px rgba(255, 255, 255, 0.05)",
        "focus":   "0 0 0 3px rgba(10, 132, 255, 0.35)",
      },
    },
  },
  plugins: [],
};

export default config;

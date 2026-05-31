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
          base:    "#1a1a1c",
          // Standard card / panel surface.
          raised:  "#252527",
          // Elevated surface (modals, popovers, tooltip backgrounds).
          overlay: "#2c2c2e",
          // Subtle hover lift, also used for inset rows.
          hover:   "#323234",
          // Even-more-subtle row-stripe / pressed state.
          sunken:  "#1f1f21",
        },
        separator: {
          // Hairline borders — barely visible, just enough to delineate.
          DEFAULT: "rgba(255, 255, 255, 0.08)",
          strong:  "rgba(255, 255, 255, 0.12)",
          subtle:  "rgba(255, 255, 255, 0.05)",
        },
        text: {
          primary:   "#f5f5f7",  // headlines, key data
          secondary: "#a1a1a6",  // body labels, meta
          tertiary:  "#6e6e73",  // captions, placeholders, disabled
          inverse:   "#1d1d1f",  // text-on-accent for high-contrast surfaces
        },
        accent: {
          // Apple "Blue" system color in dark mode — primary action.
          DEFAULT: "#0a84ff",
          hover:   "#409cff",
          subtle:  "rgba(10, 132, 255, 0.15)",
        },
        success: {
          DEFAULT: "#30d158",
          hover:   "#5cd97a",
          subtle:  "rgba(48, 209, 88, 0.15)",
        },
        warning: {
          DEFAULT: "#ff9f0a",
          hover:   "#ffb340",
          subtle:  "rgba(255, 159, 10, 0.15)",
        },
        danger: {
          DEFAULT: "#ff453a",
          hover:   "#ff6961",
          subtle:  "rgba(255, 69, 58, 0.15)",
        },
        llama: {
          // Reserved for Llama-failover indicators (banner, badge). Apple
          // "Purple" so it reads as "different mode" without alarm.
          DEFAULT: "#bf5af2",
          subtle:  "rgba(191, 90, 242, 0.18)",
        },
        // Source-badge colours (candidateSourceBadge / search-result source
        // pills). Without these tokens the badges fell back to neutral grey —
        // the talent-pool, PDL/API and LinkedIn-in-search pills lost their
        // colour-coding. Apple "Cyan" + "Indigo" so each source stays distinct
        // from accent-blue / success-green / warning-orange.
        info: {
          DEFAULT: "#64d2ff",
          subtle:  "rgba(100, 210, 255, 0.15)",
        },
        purple: {
          DEFAULT: "#5e5ce6",
          subtle:  "rgba(94, 92, 230, 0.18)",
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

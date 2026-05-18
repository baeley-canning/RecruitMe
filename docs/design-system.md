# RecruitMe — Logic Pro / Apple Dark Design System

This document is the **contract** for all UI work. Every restyled component
must conform. Hardcoded hex values inside components are forbidden — reach
for the Tailwind token classes documented below.

## Surfaces — depth from tone, not shadow

| Token             | Hex       | When to use                                          |
| ----------------- | --------- | ---------------------------------------------------- |
| `bg-surface-base` | `#1a1a1c` | Outermost shell. The page background.                |
| `bg-surface-raised` | `#252527` | Cards, panels, sidebar, toolbar.                    |
| `bg-surface-overlay`| `#2c2c2e` | Modals, popovers, tooltips.                         |
| `bg-surface-hover`  | `#323234` | Hover state on rows / buttons / interactive cards.  |
| `bg-surface-sunken` | `#1f1f21` | Inset rows, alternating stripe, pressed state.      |

Rule: shadows are **rare**. Differentiate stacked surfaces by tone, not
elevation. Only use `shadow-overlay` / `shadow-popover` on actual floating
elements (Modal, Toast, DropdownMenu).

## Separators

| Token                   | Use                                            |
| ----------------------- | ---------------------------------------------- |
| `border-separator`      | Default hairline (rgba 0.08). Card outlines, row dividers. |
| `border-separator-strong` | Slightly more visible (rgba 0.12). Section breaks. |
| `border-separator-subtle` | Almost invisible (rgba 0.05). When you want a tiny lift. |

Always 1px. Never 2px+. Borders are background-tone separators, not heavy lines.

## Text

| Token                 | Hex       | Use                                          |
| --------------------- | --------- | -------------------------------------------- |
| `text-text-primary`   | `#f5f5f7` | Headlines, key data, names.                  |
| `text-text-secondary` | `#a1a1a6` | Body labels, meta info, descriptions.        |
| `text-text-tertiary`  | `#6e6e73` | Captions, placeholders, disabled state, timestamps. |
| `text-text-inverse`   | `#1d1d1f` | Text on accent-colored backgrounds (rare). |

## Accents

| Token             | Hex       | Use                                                  |
| ----------------- | --------- | ---------------------------------------------------- |
| `accent` (`#0a84ff`)  | Apple system blue. Primary actions, selected state, links. |
| `success` (`#30d158`) | Confirmed, healthy, ready.                             |
| `warning` (`#ff9f0a`) | Attention needed, rate limit, soft warning.            |
| `danger` (`#ff453a`)  | Errors, destructive actions, failed.                   |
| `llama` (`#bf5af2`)   | Generic accent purple — used by cover-letter chips, remote-role indicators, "contacted" status, and a few other unrelated UI surfaces. Despite the name, no longer tied to any AI failover (see commit ripping out the Ollama integration). |

For all accents, use `*-subtle` variants for soft chip / pill backgrounds:
`bg-accent-subtle text-accent` is the standard "blue badge" pattern.

## Typography

| Class         | Size / Use                                              |
| ------------- | ------------------------------------------------------- |
| `font-sans`   | UI — SF Pro Text / Display via -apple-system stack. Default. |
| `font-mono`   | Data — SF Mono. Apply on: scores, percentages, candidate counts, IDs, durations, timestamps that need alignment. |
| `data-mono`   | Convenience class (in `globals.css`) — `font-mono` + tabular-nums. Reach for this on numeric data. |
| `text-2xs`    | 10px — micro labels (status pills, sidebar section labels). |
| `text-xs`     | 11px — meta info, captions.                             |
| `text-sm`     | 12px — secondary body text, table rows.                 |
| `text-base`   | 13px — **default body** (smaller than Tailwind's 16px default — we are dense). |
| `text-md`     | 14px — buttons, primary labels.                         |
| `text-lg`     | 17px — section headings.                                |
| `text-xl`     | 22px — page titles.                                     |
| `text-2xl`    | 28px — hero / dashboard headlines.                      |

Weight: prefer `font-medium` (500) for labels, `font-semibold` (590) for
headings. Avoid `font-bold` (700) — Logic Pro is restrained.

## Radii

| Class        | px    | Use                                              |
| ------------ | ----- | ------------------------------------------------ |
| `rounded-xs` | 3px   | Tiny chips, keyboard-shortcut badges.            |
| `rounded-sm` | 5px   | Pills, badges, small buttons.                    |
| `rounded`    | 6px   | **Default.** Inputs, buttons, score badges.      |
| `rounded-md` | 8px   | Cards, popover triggers.                         |
| `rounded-lg` | 10px  | Big cards (job panel, candidate card outer).     |
| `rounded-xl` | 12px  | Largest — modals, hero cards. Anything bigger feels iOS, not macOS pro. |

## Spacing

Default to **dense** scales: `gap-1.5` / `p-2` / `px-3 py-2` for compact
rows, `p-4` / `p-5` for cards. Avoid `p-6+` — that's iPad Catalyst, not
Logic Pro.

## Component recipes

These are the canonical patterns. Diverging from them needs a reason.

### Buttons

```tsx
// Primary
<button className="h-7 px-3 rounded bg-accent hover:bg-accent-hover text-white text-md font-medium transition-colors">
  Search
</button>

// Secondary (most common)
<button className="h-7 px-3 rounded bg-surface-hover hover:bg-[#3a3a3c] text-text-primary text-md border border-separator transition-colors">
  Cancel
</button>

// Ghost — toolbar / sidebar icon buttons
<button className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors">
  <Icon />
</button>

// Danger
<button className="h-7 px-3 rounded bg-danger-subtle hover:bg-danger/30 text-danger text-md font-medium transition-colors">
  Delete
</button>
```

Button heights: `h-7` (28px) for default, `h-6` (24px) for compact rows,
`h-8` (32px) for modal footers. Never taller than `h-9`.

### Cards / Panels

```tsx
<section className="rounded-md bg-surface-raised border border-separator">
  <header className="px-4 py-2.5 border-b border-separator flex items-center gap-2">
    <h2 className="text-md font-semibold text-text-primary">Pipeline</h2>
  </header>
  <div className="p-4">...</div>
</section>
```

### Pills / Badges

```tsx
// Status pill (subtle, monospace numbers if numeric)
<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-xs font-medium bg-accent-subtle text-accent">
  Active
</span>

// Count chip (always monospace)
<span className="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 h-5 rounded-sm bg-surface-hover text-text-secondary text-xs data-mono">
  14
</span>
```

### Inputs

```tsx
<input className="h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all" />
```

### Toolbars (page chrome)

Use the `.toolbar` class from `globals.css` as the starting point — it gives
you the 36px height, hairline-bottom, raised background. Then compose with
icon-buttons, segmented controls, and search inputs.

### Numeric data

Anything that is a number, score, count, percentage, or fixed-width ID gets
`.data-mono` (or `font-mono`) + `tabular-nums`. This is non-negotiable —
it's a defining characteristic of the Pro App aesthetic.

```tsx
<span className="data-mono text-text-primary">82%</span>
<span className="data-mono text-text-secondary">14 / 20</span>
```

## Model provenance pill

The candidate-card provenance pill shows which AI provider produced a
match score or acceptance likelihood — Claude or OpenAI's GPT. Claude
uses the standard `accent` tone; OpenAI uses `success`. No score
penalty is applied either way; the pill exists for transparency, not
to demote one provider's output.

```tsx
// "Claude" pill (default tone)
<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-xs font-medium bg-accent-subtle text-accent">
  Claude
</span>

// "GPT" pill (when Claude fails over to OpenAI)
<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-xs font-medium bg-success-subtle text-success">
  GPT
</span>
```

## What NOT to do

- ❌ Hardcoded hex values in components (`bg-[#252527]` is forbidden; use
  `bg-surface-raised`).
- ❌ Tailwind's default `slate-*` / `gray-*` / `blue-*` palettes in NEW work.
  Old `slate-` references in unmodified files are fine for now; rip them
  when you touch the file.
- ❌ Light shadows (`shadow-sm`, `shadow-md`, etc.) on cards / panels — flat
  surfaces only. Shadows only on floating overlays.
- ❌ `text-lg` body text. The Pro App scale tops out around 17px for
  headings; body is 13px (`text-base`).
- ❌ Pills bigger than `text-xs` / `h-5`. Big pills are iPad, not Logic Pro.
- ❌ `font-bold` (700). Maximum weight is `font-semibold` (590).
- ❌ Rounded corners larger than `rounded-xl` (12px) anywhere.
- ❌ Three-line spacing (`p-6+`). We are dense.

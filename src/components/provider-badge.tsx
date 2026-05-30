/**
 * Live status pill for an external provider (Claude, OpenAI, SerpAPI, PDL,
 * Firmable, GitHub). Colour comes from the `state` field returned by
 * [[/api/ai/status]], which is derived from in-memory provider-health
 * signals recorded by every provider call site (see [[provider-health.ts]]).
 *
 *   healthy     → green   recent successful call
 *   degraded    → amber   intermittent failures OR stale
 *   down        → red     repeated failures OR Claude flagged dead
 *   untested    → amber   configured but never called
 *   unconfigured → muted   not set up (hidden by default — see `showUnconfigured`)
 *
 * Hover the badge for the most recent failure reason. The label is the
 * provider's friendly name; the colour does the heavy lifting.
 */
"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

export type ProviderName =
  | "claude"
  | "openai"
  | "pdl"
  | "firmable"
  | "github";

export type ProviderState =
  | "healthy"
  | "degraded"
  | "down"
  | "unconfigured"
  | "untested";

export interface ProviderHealth {
  name: ProviderName;
  configured: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  consecutiveFailures: number;
  state: ProviderState;
}

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude:   "Claude",
  openai:   "GPT",
  pdl:      "PDL",
  firmable: "Firmable",
  github:   "GitHub",
};

/**
 * Map (state, providerName) → Tailwind colour classes.
 *
 * Five visually distinct states:
 *   healthy      green   recent successful call (proven working)
 *   untested     muted   configured, never called this process lifetime
 *                        (visually distinct from healthy so a post-restart
 *                        badge row doesn't claim everything is verified
 *                        when nothing has been called yet — violating the
 *                        "no gaslighting" UX principle)
 *   degraded     amber   recent failures, but not yet 3 in a row
 *   down         red     fatal failure OR 3+ consecutive failures
 *   unconfigured hidden  env var not set (default-hidden)
 *
 */
function colourClasses(state: ProviderState, name: ProviderName): string {
  // OpenAI gets the dedicated success-tone token so recruiters can spot
  // at a glance when scoring is being handled by the GPT fallback
  // rather than Claude. (Same idea as the prior Llama-purple convention.)
  if (name === "openai" && state === "healthy") {
    return "bg-success-subtle text-success";
  }
  switch (state) {
    case "healthy":      return "bg-success-subtle text-success";
    case "untested":     return "bg-surface-hover text-text-secondary";  // distinct neutral — configured but unverified
    case "degraded":     return "bg-warning-subtle text-warning";
    case "down":         return "bg-danger-subtle text-danger";
    case "unconfigured": return "bg-surface-hover text-text-tertiary";
  }
}

function buildTooltip(health: ProviderHealth): string {
  const label = PROVIDER_LABELS[health.name];
  if (health.state === "unconfigured") return `${label} is not configured`;
  if (health.state === "untested")     return `${label} key set — not yet verified by a real call`;
  if (health.state === "down" && health.lastFailureReason) {
    return `${label} appears down: ${health.lastFailureReason}`;
  }
  if (health.state === "degraded" && health.lastFailureReason) {
    return `${label} intermittent: ${health.lastFailureReason}`;
  }
  if (health.state === "healthy" && health.lastSuccessAt) {
    const when = new Date(health.lastSuccessAt);
    return `${label} healthy — last success ${when.toLocaleTimeString()}`;
  }
  return label;
}

interface ProviderBadgeProps {
  health: ProviderHealth;
  /** When true, render even if the provider isn't configured. Defaults to
   *  false so unused providers don't clutter the UI. */
  showUnconfigured?: boolean;
}

export function ProviderBadge({ health, showUnconfigured = false }: ProviderBadgeProps) {
  const label = PROVIDER_LABELS[health.name];
  const tooltip = useMemo(() => buildTooltip(health), [health]);

  if (!showUnconfigured && health.state === "unconfigured") return null;

  return (
    <span
      title={tooltip}
      // aria-label carries the full state + reason so colour-blind /
      // screen-reader users get the same signal as the visual colour.
      // role="status" tells AT this is a live state indicator, not just
      // a decorative label.
      role="status"
      aria-label={`${label}: ${health.state}. ${tooltip}`}
      className={cn(
        "text-xs px-1.5 py-0.5 rounded-sm font-medium",
        colourClasses(health.state, health.name),
      )}
    >
      {label}
    </span>
  );
}

/**
 * Renders the relevant providers as a horizontal row of badges. Hides
 * unconfigured providers by default. Sorts so the AI providers (Claude /
 * GPT) appear first, then search/enrichment, then GitHub.
 */
export function ProviderBadgeRow({
  providers,
  showUnconfigured = false,
}: {
  providers: ProviderHealth[];
  showUnconfigured?: boolean;
}) {
  // Order: AI providers first (Claude/GPT), then enrichment + GitHub.
  // Keeps related providers visually grouped.
  const order: ProviderName[] = [
    "claude", "openai",
    "pdl", "firmable", "github",
  ];
  const sorted = [...providers].sort(
    (a, b) => order.indexOf(a.name) - order.indexOf(b.name),
  );

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {sorted.map((health) => (
        <ProviderBadge
          key={health.name}
          health={health}
          showUnconfigured={showUnconfigured}
        />
      ))}
    </div>
  );
}

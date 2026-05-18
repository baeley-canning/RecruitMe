"use client";

import type { BadgeDescriptor, BadgeTone, CandidateBadgeState } from "@/lib/insight-badges";
import { decideBadges } from "@/lib/insight-badges";
import { isInsightBadgesEnabledClient } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";

/**
 * Renders the per-candidate badge row introduced in PR 4. Flag-gated by
 * `NEXT_PUBLIC_RECRUITME_PROFILE_INSIGHT_UI_BADGES`. When the flag is off
 * the component renders null — keep the existing card layout untouched
 * until the rollout is validated per plan §H.
 *
 * The decision logic lives in src/lib/insight-badges.ts (pure, unit-tested);
 * this component is just visual presentation.
 */

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-surface-hover text-text-tertiary",
  accent:  "bg-accent-subtle text-accent",
  warning: "bg-warning-subtle text-warning",
  danger:  "bg-danger-subtle text-danger",
};

export function InsightBadges({ state }: { state: CandidateBadgeState }) {
  if (!isInsightBadgesEnabledClient()) return null;
  const badges = decideBadges(state);
  if (badges.length === 0) return null;
  return (
    <div className="inline-flex flex-wrap items-center gap-1">
      {badges.map((b) => (
        <InsightBadgePill key={b.kind} badge={b} />
      ))}
    </div>
  );
}

function InsightBadgePill({ badge }: { badge: BadgeDescriptor }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded-sm text-2xs font-medium uppercase tracking-wide leading-none",
        TONE_CLASSES[badge.tone],
      )}
      title={badge.tooltip}
      aria-label={`${badge.label}. ${badge.tooltip}`}
    >
      {badge.label}
    </span>
  );
}

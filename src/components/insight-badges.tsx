"use client";

import type { BadgeDescriptor, BadgeTone, CandidateBadgeState } from "@/lib/insight-badges";
import { decideBadges } from "@/lib/insight-badges";
import { cn } from "@/lib/utils";

/**
 * Renders the per-candidate badge row. Shipped always-on as of May 2026.
 *
 * Previously gated by NEXT_PUBLIC_RECRUITME_PROFILE_INSIGHT_UI_BADGES; the
 * flag was removed when the badges proved valuable independent of the
 * insight extractor rollout (library_only / scored / needs_rescore /
 * from_jobadder render from data the candidate API already returns;
 * insight_reused stays inactive until the extractor populates Insight rows).
 *
 * Decision logic lives in src/lib/insight-badges.ts (pure, unit-tested);
 * this component is just presentation.
 */

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-surface-hover text-text-tertiary",
  accent:  "bg-accent-subtle text-accent",
  warning: "bg-warning-subtle text-warning",
  danger:  "bg-danger-subtle text-danger",
};

export function InsightBadges({ state }: { state: CandidateBadgeState }) {
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

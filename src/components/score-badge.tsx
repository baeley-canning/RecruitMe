import { cn } from "@/lib/utils";
import { scoreTier, scoreTierColor, scoreTierLabel } from "@/lib/score-utils";

interface ScoreBadgeProps {
  score: number | null | undefined;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Thin-data estimate (SEEK card / snippet — scored from headline+location
   *  only). Renders a muted "est" marker so a recruiter never mistakes a
   *  keyword estimate for a verified full-profile score. Default false. */
  estimate?: boolean;
  /** Stack the tier word ("Strong" / "Fair" / "Weak" / "Poor") beneath the
   *  number. A bare 61% asks the recruiter to remember where the breakpoints
   *  are; the word states the verdict the number already encodes. Off by
   *  default — only worth the vertical space where the score is the primary
   *  thing on the row. */
  band?: boolean;
}

// Score tier colours are now driven by the canonical scoreTier / scoreTierColor
// helpers in src/lib/score-utils.ts. ScoreBadge was the de-facto source of
// truth (80/65/50) before consolidation — those breakpoints are the ones
// score-utils.ts adopted, so this component's visuals are unchanged.

export function ScoreBadge({ score, size = "md", className, estimate = false, band = false }: ScoreBadgeProps) {
  // Sizing — kept dense per design system. Numbers always use mono +
  // tabular-nums so digits line up across rows.
  const sizeClasses = {
    sm: "text-xs px-1.5 py-0.5 rounded-sm",
    md: "text-sm px-2 py-0.5 rounded",
    lg: "text-md px-2.5 py-1 rounded",
  };

  if (score == null) {
    return (
      <span
        className={cn(
          "inline-flex items-center font-mono tabular-nums bg-surface-hover text-text-tertiary",
          sizeClasses[size],
          className
        )}
      >
        —
      </span>
    );
  }

  const tier = scoreTier(score, "match");

  return (
    <span
      className={cn(
        band ? "inline-flex flex-col items-center leading-none" : "inline-flex items-baseline gap-0.5",
        "font-medium",
        scoreTierColor(tier),
        estimate && "opacity-80",
        sizeClasses[size],
        className
      )}
      title={estimate ? "Estimate — scored from headline & location only. Fetch the full profile to confirm." : undefined}
    >
      <span className={cn(band && "inline-flex items-baseline gap-0.5")}>
        <span className="font-mono tabular-nums">{score}</span>
        <span className="text-text-tertiary text-2xs">%</span>
        {estimate && <span className="text-2xs font-normal text-text-tertiary ml-0.5">est</span>}
      </span>
      {band && (
        <span className="mt-1 text-2xs font-normal uppercase tracking-wider text-text-tertiary">
          {scoreTierLabel(tier)}
        </span>
      )}
    </span>
  );
}

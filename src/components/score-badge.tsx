import { cn } from "@/lib/utils";

interface ScoreBadgeProps {
  score: number | null | undefined;
  size?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * Score tier colors — Logic Pro / Pro App palette.
 *
 *   80+   strong match     → success (green)
 *   65-79 promising        → accent  (blue)
 *   50-64 needs review     → warning (amber)
 *   <50   weak             → neutral (no red — failure is the recruiter's call)
 */
function tierClasses(score: number): string {
  if (score >= 80) return "bg-success-subtle text-success";
  if (score >= 65) return "bg-accent-subtle text-accent";
  if (score >= 50) return "bg-warning-subtle text-warning";
  return "bg-surface-hover text-text-secondary";
}

export function ScoreBadge({ score, size = "md", className }: ScoreBadgeProps) {
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

  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-0.5 font-medium",
        tierClasses(score),
        sizeClasses[size],
        className
      )}
    >
      <span className="font-mono tabular-nums">{score}</span>
      <span className="text-text-tertiary text-2xs">%</span>
    </span>
  );
}

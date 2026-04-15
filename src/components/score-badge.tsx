import { cn, scoreBg } from "@/lib/utils";

interface ScoreBadgeProps {
  score: number | null | undefined;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function ScoreBadge({ score, size = "md", className }: ScoreBadgeProps) {
  const sizeClasses = {
    sm: "text-xs px-2 py-0.5 font-semibold rounded-md",
    md: "text-sm px-2.5 py-1 font-semibold rounded-lg",
    lg: "text-base px-3 py-1.5 font-bold rounded-lg",
  };

  if (score == null) {
    return (
      <span
        className={cn(
          "inline-flex items-center bg-slate-100 text-slate-400",
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
        "inline-flex items-center gap-1",
        scoreBg(score),
        sizeClasses[size],
        className
      )}
    >
      {score}%
    </span>
  );
}

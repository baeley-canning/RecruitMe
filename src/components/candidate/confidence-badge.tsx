import type { Confidence } from "@/lib/confidence";

/**
 * Subtle record-confidence dot + label. This is a DATA-trust signal (do we have
 * a solid, fresh, corroborated record) — deliberately visually quieter than the
 * matchScore tier so it's never confused with role fit. The tooltip lists the
 * reasons so a low confidence is explainable, not mysterious.
 */
const TONE: Record<Confidence["level"], string> = {
  high: "text-success",
  medium: "text-warning",
  low: "text-text-tertiary",
};

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-2xs text-text-tertiary"
      title={`Record confidence: ${confidence.level} (${confidence.score}/100)\n· ${confidence.reasons.join("\n· ")}`}
    >
      <span className={TONE[confidence.level]} aria-hidden>●</span>
      {confidence.level} confidence
    </span>
  );
}

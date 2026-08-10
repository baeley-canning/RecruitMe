"use client";

import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { scoreTier } from "@/lib/score-utils";
import {
  type ScoreBreakdown,
  type MustHaveCoverageStatus,
  type NiceToHaveCoverageStatus,
} from "@/lib/scoring";

// Solid-fill progress-bar colour per tier (the canonical scoreTierColor
// returns subtle bg + matching text colour for badges; the inline progress
// bars in this panel want a single solid background colour). Bucketing is
// driven by scoreTier so breakpoints stay in lock-step with the rest of the
// app — only the colour mapping is bespoke.
// Per-category bar fills. The "poor" tier uses bg-danger (red) to flag a
// problem category, matching CATEGORY_BAR_FILL in candidate-card.tsx — same
// underlying data, kept visually consistent.
const TIER_FILL: Record<ReturnType<typeof scoreTier>, string> = {
  strong: "bg-success",
  fair:   "bg-accent",
  weak:   "bg-warning",
  poor:   "bg-danger",
};

// ─── Coverage chip configs ────────────────────────────────────────────────────

const MH_CONFIG: Record<MustHaveCoverageStatus, { bg: string; text: string; icon: string }> = {
  confirmed:         { bg: "bg-success-subtle border-separator", text: "text-success",        icon: "✓" },
  equivalent:        { bg: "bg-success-subtle border-separator", text: "text-success",        icon: "≈" },
  likely:            { bg: "bg-accent-subtle border-separator",  text: "text-accent",         icon: "~" },
  likely_historical: { bg: "bg-warning-subtle border-separator", text: "text-warning",        icon: "⟳" },
  missing:           { bg: "bg-surface-hover border-separator",  text: "text-text-secondary", icon: "?" },
  negative:          { bg: "bg-surface-hover border-separator",  text: "text-text-tertiary",  icon: "✗" },
  unknown:           { bg: "bg-surface-hover border-separator",  text: "text-text-tertiary",  icon: "?" },
};

const NTH_CONFIG: Record<NiceToHaveCoverageStatus, { bg: string; text: string; icon: string }> = {
  confirmed: { bg: "bg-accent-subtle border-separator",   text: "text-accent",         icon: "✓" },
  likely:    { bg: "bg-surface-hover border-separator",   text: "text-text-secondary", icon: "~" },
  absent:    { bg: "bg-surface-hover border-separator",   text: "text-text-tertiary",  icon: "–" },
};

function chip(requirement: string, evidence: string, cfg: { bg: string; text: string; icon: string }, key: number) {
  const label = requirement.length > 32 ? requirement.slice(0, 30) + "…" : requirement;
  return (
    <span
      key={key}
      title={evidence}
      className={cn(
        "inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded border font-medium cursor-default",
        cfg.bg, cfg.text
      )}
    >
      <span className="text-[10px]">{cfg.icon}</span>
      {label}
    </span>
  );
}

function MustHaveCoverageChips({ coverage }: { coverage: ScoreBreakdown["must_have_coverage"] }) {
  if (coverage.length === 0) return null;
  const order: MustHaveCoverageStatus[] = ["confirmed", "equivalent", "likely", "likely_historical", "unknown", "missing", "negative"];
  const sorted = [...coverage].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <div>
      <p className="text-xs font-medium text-text-secondary mb-1.5">Must-haves</p>
      <div className="flex flex-wrap gap-1">
        {sorted.map((c, i) => chip(c.requirement, c.evidence, MH_CONFIG[c.status], i))}
      </div>
      <p className="text-2xs text-text-tertiary mt-1">Hover for evidence from the profile</p>
    </div>
  );
}

function NiceToHaveCoverageChips({ coverage }: { coverage: NonNullable<ScoreBreakdown["nice_to_have_coverage"]> }) {
  if (!coverage || coverage.length === 0) return null;
  const order: NiceToHaveCoverageStatus[] = ["confirmed", "likely", "absent"];
  const sorted = [...coverage].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <div>
      <p className="text-xs font-medium text-text-secondary mb-1.5">Nice-to-haves</p>
      <div className="flex flex-wrap gap-1">
        {sorted.map((c, i) => chip(c.requirement, c.evidence, NTH_CONFIG[c.status], i))}
      </div>
    </div>
  );
}

// Coverage summary "ribbon" — action-plan #5 (design-panel winner: UI-only, zero
// scoring-math change). The hero trust signal a recruiter acts on at a glance:
// how many must-haves are actually confirmed, plus the data quality the score is
// based on. Pure presentation over the already-computed must_have_coverage — no
// caps, no formula change, scores stay byte-identical.
function CoverageSummary({
  coverage,
  dataQuality,
}: {
  coverage: ScoreBreakdown["must_have_coverage"];
  dataQuality: ScoreBreakdown["data_quality"];
}) {
  const total = coverage.length;
  if (total === 0) return null;
  const met    = coverage.filter((c) => c.status === "confirmed" || c.status === "equivalent").length;
  const likely = coverage.filter((c) => c.status === "likely" || c.status === "likely_historical").length;
  const pct = (n: number) => `${(n / total) * 100}%`;
  const qualityLabel =
    dataQuality === "full_profile" ? "full profile" :
    dataQuality === "minimal"      ? "estimate · headline only" : "snippet";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-sm font-semibold text-text-primary">
          {met} / {total} must-haves confirmed{likely > 0 ? ` · ${likely} likely` : ""}
        </span>
        <span className="text-2xs text-text-tertiary whitespace-nowrap">{qualityLabel}</span>
      </div>
      <div className="flex h-2 w-full rounded-full overflow-hidden bg-surface-sunken">
        {met > 0 && <div className="bg-success h-full" style={{ width: pct(met) }} title={`${met} confirmed / equivalent`} />}
        {likely > 0 && <div className="bg-accent h-full" style={{ width: pct(likely) }} title={`${likely} likely`} />}
      </div>
    </div>
  );
}

// ─── Public exports used by MH_CONFIG in the drawer too ───────────────────────
export { MH_CONFIG };

// ─── ScoreBreakdownPanel ──────────────────────────────────────────────────────

interface ScoreBreakdownPanelProps {
  breakdown: ScoreBreakdown | null;
  matchReason: { summary?: string; reasoning?: string; dimensions?: Record<string, number>; strengths?: string[]; gaps?: string[] } | null;
  showReasoning: boolean;
  setShowReasoning: (v: boolean | ((prev: boolean) => boolean)) => void;
  displaySummary: string | null;
  // Lazy-load support: the parent fetches scoreBreakdown on demand (see
  // candidate-card.tsx). Setting `canLoadBreakdown` keeps the "Why?" toggle
  // visible even when `breakdown` is still null so the user can trigger the
  // fetch; `breakdownLoading` and `breakdownError` drive in-panel state for
  // the fetch lifecycle, with `onRetryBreakdown` rerunning the fetch on error.
  canLoadBreakdown?: boolean;
  breakdownLoading?: boolean;
  breakdownError?: boolean;
  onRetryBreakdown?: () => void;
}

export function ScoreBreakdownPanel({
  breakdown,
  matchReason,
  showReasoning,
  setShowReasoning,
  displaySummary,
  canLoadBreakdown = false,
  breakdownLoading = false,
  breakdownError = false,
  onRetryBreakdown,
}: ScoreBreakdownPanelProps) {
  if (!displaySummary) return null;

  // Show the toggle if the parsed breakdown has any coverage (the v1 case)
  // OR the parent has signaled it can lazy-load the breakdown on demand
  // (the v2 case, where the list payload doesn't carry the breakdown).
  const showToggle = (breakdown?.must_have_coverage?.length ?? 0) > 0 || canLoadBreakdown;

  return (
    <div className="px-4 pb-2">
      {/* The summary itself is rendered on the candidate row now, next to the
          score, so it is NOT repeated here — printing it in both places made
          every card say the same sentence twice. This strip keeps the "Why?"
          expander, which is the part that reveals something new. */}
      <div className="flex items-start justify-end gap-2">
        {showToggle && (
          <button
            onClick={() => setShowReasoning((v) => !v)}
            className="text-xs text-accent hover:text-accent-hover whitespace-nowrap flex items-center gap-0.5 flex-shrink-0 mt-0.5 font-medium transition-colors"
          >
            Why?
            <ChevronDown className={cn("w-3 h-3 transition-transform", showReasoning && "rotate-180")} />
          </button>
        )}
      </div>
      {showReasoning && (
        <div className="mt-2">
          {breakdownLoading && !breakdown ? (
            <p className="text-xs text-text-tertiary italic">Loading reasoning…</p>
          ) : breakdownError && !breakdown ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-danger">Couldn&rsquo;t load reasoning.</span>
              {onRetryBreakdown && (
                <button
                  type="button"
                  onClick={onRetryBreakdown}
                  className="text-accent hover:text-accent-hover font-medium underline underline-offset-2"
                >
                  Retry
                </button>
              )}
            </div>
          ) : breakdown ? (
            <div className="space-y-3">
              {/* #5 hero: must-have coverage summary, before the per-requirement detail */}
              {breakdown.must_have_coverage.length > 0 && (
                <CoverageSummary coverage={breakdown.must_have_coverage} dataQuality={breakdown.data_quality} />
              )}
              {/* Coverage chips: must-haves + nice-to-haves */}
              <div className="space-y-2">
                {breakdown.must_have_coverage.length > 0 && (
                  <MustHaveCoverageChips coverage={breakdown.must_have_coverage} />
                )}
                {breakdown.version === 2 && breakdown.nice_to_have_coverage?.length > 0 && (
                  <NiceToHaveCoverageChips coverage={breakdown.nice_to_have_coverage} />
                )}
              </div>

              {/* Evidence coverage indicator (v2 only) */}
              {breakdown.version === 2 && breakdown.evidence_coverage_score !== undefined && (
                <div className="flex items-center gap-2">
                  <span className="text-2xs text-text-tertiary whitespace-nowrap">Evidence coverage</span>
                  <div className="h-1.5 flex-1 bg-surface-sunken rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        breakdown.evidence_coverage_score >= 60 ? "bg-success" :
                        breakdown.evidence_coverage_score >= 30 ? "bg-warning" : "bg-surface-hover"
                      )}
                      style={{ width: `${breakdown.evidence_coverage_score}%` }}
                    />
                  </div>
                  <span className="text-2xs text-text-tertiary tabular-nums w-7 text-right data-mono">
                    {breakdown.evidence_coverage_score}%
                  </span>
                </div>
              )}

              {/* Category score bars */}
              <div className="space-y-1">
                <p className="text-xs font-medium text-text-secondary">Score breakdown</p>
                {(Object.entries(breakdown.categories) as [string, { score: number; evidence: string }][]).map(([key, cat]) => (
                  <div key={key} className="flex items-start gap-2">
                    <div className="flex items-center gap-1.5 w-28 flex-shrink-0">
                      <div className="h-1.5 flex-1 bg-surface-sunken rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            TIER_FILL[scoreTier(cat.score, "match")],
                          )}
                          style={{ width: `${cat.score}%` }}
                        />
                      </div>
                      <span className="text-2xs text-text-secondary tabular-nums w-7 text-right data-mono">{cat.score}%</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-2xs font-medium text-text-tertiary uppercase tracking-wide">
                        {key.replace(/_/g, " ").replace(" fit", "")}
                      </span>
                      {cat.evidence && (
                        <p className="text-2xs text-text-secondary leading-snug">{cat.evidence}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : matchReason?.reasoning ? (
            <div className="p-3 bg-accent-subtle border border-separator rounded-md">
              <p className="text-xs font-medium text-accent mb-1">AI Assessment</p>
              <p className="text-xs text-text-primary leading-relaxed">{matchReason.reasoning}</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

"use client";

import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type ScoreBreakdown,
  type MustHaveCoverageStatus,
  type NiceToHaveCoverageStatus,
} from "@/lib/scoring";

// ─── Coverage chip configs ────────────────────────────────────────────────────

const MH_CONFIG: Record<MustHaveCoverageStatus, { bg: string; text: string; icon: string }> = {
  confirmed:         { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", icon: "✓" },
  equivalent:        { bg: "bg-teal-50 border-teal-200",       text: "text-teal-700",    icon: "≈" },
  likely:            { bg: "bg-blue-50 border-blue-200",       text: "text-blue-700",    icon: "~" },
  likely_historical: { bg: "bg-amber-50 border-amber-200",    text: "text-amber-700",   icon: "⟳" },
  missing:           { bg: "bg-slate-50 border-slate-200",     text: "text-slate-500",   icon: "?" },
  negative:          { bg: "bg-red-50 border-red-200",         text: "text-red-700",     icon: "✗" },
  unknown:           { bg: "bg-slate-50 border-slate-200",     text: "text-slate-400",   icon: "?" },
};

const NTH_CONFIG: Record<NiceToHaveCoverageStatus, { bg: string; text: string; icon: string }> = {
  confirmed: { bg: "bg-violet-50 border-violet-200",  text: "text-violet-700",  icon: "✓" },
  likely:    { bg: "bg-slate-50 border-slate-200",    text: "text-slate-500",   icon: "~" },
  absent:    { bg: "bg-slate-50 border-slate-100",    text: "text-slate-400",   icon: "–" },
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
      <p className="text-xs font-medium text-slate-500 mb-1.5">Must-haves</p>
      <div className="flex flex-wrap gap-1">
        {sorted.map((c, i) => chip(c.requirement, c.evidence, MH_CONFIG[c.status], i))}
      </div>
      <p className="text-[10px] text-slate-400 mt-1">Hover for evidence from the profile</p>
    </div>
  );
}

function NiceToHaveCoverageChips({ coverage }: { coverage: NonNullable<ScoreBreakdown["nice_to_have_coverage"]> }) {
  if (!coverage || coverage.length === 0) return null;
  const order: NiceToHaveCoverageStatus[] = ["confirmed", "likely", "absent"];
  const sorted = [...coverage].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <div>
      <p className="text-xs font-medium text-slate-500 mb-1.5">Nice-to-haves</p>
      <div className="flex flex-wrap gap-1">
        {sorted.map((c, i) => chip(c.requirement, c.evidence, NTH_CONFIG[c.status], i))}
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
}

export function ScoreBreakdownPanel({
  breakdown,
  matchReason,
  showReasoning,
  setShowReasoning,
  displaySummary,
}: ScoreBreakdownPanelProps) {
  if (!displaySummary) return null;

  return (
    <div className="px-4 pb-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-slate-600 leading-relaxed italic flex-1">
          &ldquo;{displaySummary}&rdquo;
        </p>
        {(breakdown?.must_have_coverage?.length ?? 0) > 0 && (
          <button
            onClick={() => setShowReasoning((v) => !v)}
            className="text-xs text-blue-600 hover:text-blue-700 whitespace-nowrap flex items-center gap-0.5 flex-shrink-0 mt-0.5 font-medium"
          >
            Why?
            <ChevronDown className={cn("w-3 h-3 transition-transform", showReasoning && "rotate-180")} />
          </button>
        )}
      </div>
      {showReasoning && (
        <div className="mt-2">
          {breakdown ? (
            <div className="space-y-3">
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
                  <span className="text-[10px] text-slate-400 whitespace-nowrap">Evidence coverage</span>
                  <div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        breakdown.evidence_coverage_score >= 60 ? "bg-emerald-400" :
                        breakdown.evidence_coverage_score >= 30 ? "bg-amber-400" : "bg-slate-300"
                      )}
                      style={{ width: `${breakdown.evidence_coverage_score}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-slate-400 tabular-nums w-7 text-right">
                    {breakdown.evidence_coverage_score}%
                  </span>
                </div>
              )}

              {/* Category score bars */}
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-500">Score breakdown</p>
                {(Object.entries(breakdown.categories) as [string, { score: number; evidence: string }][]).map(([key, cat]) => (
                  <div key={key} className="flex items-start gap-2">
                    <div className="flex items-center gap-1.5 w-28 flex-shrink-0">
                      <div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            cat.score >= 80 ? "bg-emerald-500" :
                            cat.score >= 60 ? "bg-blue-500" :
                            cat.score >= 40 ? "bg-amber-500" : "bg-red-400"
                          )}
                          style={{ width: `${cat.score}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-slate-500 tabular-nums w-7 text-right">{cat.score}%</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">
                        {key.replace(/_/g, " ").replace(" fit", "")}
                      </span>
                      {cat.evidence && (
                        <p className="text-[10px] text-slate-500 leading-snug">{cat.evidence}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : matchReason?.reasoning ? (
            <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg">
              <p className="text-xs font-medium text-blue-800 mb-1">AI Assessment</p>
              <p className="text-xs text-slate-700 leading-relaxed">{matchReason.reasoning}</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

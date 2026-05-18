"use client";

import { Star, ChevronRight, TrendingDown } from "lucide-react";
import { CandidateIdentityBlock } from "@/components/candidate/identity-block";

interface Candidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  matchScore: number | null;
  status: string;
  profileCapturedAt?: string | null;
}

interface TopCandidatesCardProps {
  candidates: Candidate[];
  onShortlist: (id: string) => void;
  onView: (id: string) => void;
}

const TERMINAL = new Set(["shortlisted", "contacted", "interviewing", "offer_sent", "hired", "declined", "rejected"]);

export function TopCandidatesCard({ candidates, onShortlist, onView }: TopCandidatesCardProps) {
  const scoredCount = candidates.filter((c) => c.matchScore !== null).length;
  // Thin market: fewer than 6 scored candidates — relax threshold to 30 so the
  // card still surfaces the best available rather than showing nothing.
  const thinMarket = scoredCount > 0 && scoredCount < 6;
  const threshold = thinMarket ? 30 : 40;

  const eligible = candidates.filter((c) => c.matchScore !== null && c.matchScore >= threshold && !TERMINAL.has(c.status));
  const top = eligible
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))
    .slice(0, 3);

  if (top.length === 0) return null;

  return (
    <div className="mb-6 rounded-md border border-separator bg-surface-raised border-l-2 border-l-warning overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-separator bg-warning-subtle">
        <Star className="w-3.5 h-3.5 text-warning fill-warning" />
        <p className="text-md font-semibold text-text-primary">Top matches — ready to shortlist</p>
        {thinMarket && (
          <span className="inline-flex items-center gap-1 text-2xs font-medium px-1.5 py-0.5 bg-warning-subtle text-warning rounded-sm ml-1">
            <TrendingDown className="w-2.5 h-2.5" />
            Thin market
          </span>
        )}
        <span className="ml-auto text-xs text-text-tertiary data-mono">{top.length} candidate{top.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="divide-y divide-separator">
        {top.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-hover transition-colors">
            {/* Identity block — consistent with all other candidate views */}
            <CandidateIdentityBlock
              name={c.name}
              headline={c.headline}
              location={c.location}
              score={c.matchScore}
              size="sm"
              showScore
              className="flex-1 min-w-0"
            />

            {/* Actions */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => onShortlist(c.id)}
                className="inline-flex items-center gap-1 h-7 px-3 rounded bg-warning hover:bg-warning-hover text-text-inverse text-md font-medium transition-colors"
              >
                <Star className="w-3 h-3" />
                Shortlist
              </button>
              <button
                onClick={() => onView(c.id)}
                className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                title="View candidate"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {eligible.length > 3 && (
        <div className="px-4 py-2 text-xs text-text-tertiary border-t border-separator">
          +<span className="data-mono">{eligible.length - 3}</span> more candidates scoring <span className="data-mono">{threshold}%+</span>
        </div>
      )}
    </div>
  );
}

"use client";

import { Star, ChevronRight } from "lucide-react";
import { cn, statusBadge, statusLabel } from "@/lib/utils";
import { ScoreBadge } from "@/components/score-badge";

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
  // Only show scored, unfinalised candidates — sorted by score desc.
  const top = candidates
    .filter((c) => c.matchScore !== null && c.matchScore >= 40 && !TERMINAL.has(c.status))
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))
    .slice(0, 3);

  if (top.length === 0) return null;

  return (
    <div className="mb-6 rounded-xl border border-amber-200 bg-gradient-to-r from-amber-50 to-white overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-100">
        <Star className="w-4 h-4 text-amber-500 fill-amber-400" />
        <p className="text-sm font-semibold text-slate-800">Top matches — ready to shortlist</p>
        <span className="ml-auto text-[11px] text-slate-400">{top.length} candidate{top.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="divide-y divide-amber-100/60">
        {top.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-4 py-3">
            {/* Score badge */}
            <div className="flex-shrink-0">
              <ScoreBadge score={c.matchScore} size="sm" />
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-800 truncate">{c.name}</p>
              {c.headline && (
                <p className="text-xs text-slate-500 truncate">{c.headline}</p>
              )}
              {c.location && (
                <p className="text-[11px] text-slate-400 truncate">{c.location}</p>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => onShortlist(c.id)}
                className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-colors"
              >
                <Star className="w-3 h-3" />
                Shortlist
              </button>
              <button
                onClick={() => onView(c.id)}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                title="View candidate"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {candidates.filter(c => c.matchScore !== null && c.matchScore >= 40 && !TERMINAL.has(c.status)).length > 3 && (
        <div className="px-4 py-2 text-[11px] text-slate-400 border-t border-amber-100">
          +{candidates.filter(c => c.matchScore !== null && c.matchScore >= 40 && !TERMINAL.has(c.status)).length - 3} more candidates scoring 40%+
        </div>
      )}
    </div>
  );
}

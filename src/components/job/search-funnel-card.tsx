"use client";

import { useEffect, useState } from "react";
import { TrendingDown, Star, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface FunnelData {
  searchRuns: number;
  surfaced: number;
  filteredAtSource: number;
  imported: number;
  totalCandidates: number;
  fetched: number;
  scored: number;
  shortlisted: number;
  rejectedByRecruiter: number;
  avgScore: number | null;
}

interface FunnelStage {
  label: string;
  value: number;
  hint?: string;
}

function pct(n: number, d: number): string {
  if (d <= 0) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

export function SearchFunnelCard({ jobId, refreshKey }: { jobId: string; refreshKey?: unknown }) {
  const [data, setData] = useState<FunnelData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setError(false);
    fetch(`/api/jobs/${jobId}/search-funnel`)
      .then((r) => {
        if (!r.ok) { setError(true); return null; }
        return r.json();
      })
      .then((d: FunnelData | null) => {
        setData(d);
        setLoaded(true);
      })
      .catch(() => { setError(true); setLoaded(true); });
  }, [jobId, refreshKey]);

  if (!loaded) return null;

  // Surface the failure rather than silently rendering nothing — the funnel is
  // a diagnostic tool, so silent failure defeats its purpose.
  if (error) {
    return (
      <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2 text-xs text-amber-700">
        <AlertCircle className="w-3.5 h-3.5" />
        Couldn&apos;t load discovery funnel — refresh to try again.
      </div>
    );
  }

  if (!data) return null;

  // Don't show for empty jobs — feels like noise before any work has happened.
  if (data.searchRuns === 0 && data.totalCandidates === 0) return null;

  const stages: FunnelStage[] = [
    { label: "Surfaced", value: data.surfaced, hint: `${data.searchRuns} run${data.searchRuns !== 1 ? "s" : ""}` },
    { label: "Imported", value: data.imported, hint: pct(data.imported, data.surfaced) + " of surfaced" },
    { label: "Fetched", value: data.fetched, hint: pct(data.fetched, data.totalCandidates) + " of candidates" },
    { label: "Scored", value: data.scored, hint: data.avgScore !== null ? `avg ${data.avgScore}` : undefined },
    { label: "Shortlisted", value: data.shortlisted, hint: pct(data.shortlisted, data.scored) + " of scored" },
  ];

  // Heuristic: warn if a heavy chunk got filtered at source — usually means the
  // search query is pulling in irrelevant profiles.
  const noisyQueries =
    data.surfaced > 20 && data.filteredAtSource / Math.max(data.surfaced, 1) > 0.6;

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-slate-400" />
          <p className="text-sm font-medium text-slate-700">Discovery funnel</p>
        </div>
        {data.shortlisted > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
            <Star className="w-3 h-3" />
            {data.shortlisted} shortlisted
          </span>
        )}
      </div>

      <div className="grid grid-cols-5 gap-2">
        {stages.map((s, i) => (
          <div
            key={s.label}
            className={cn(
              "rounded-lg border px-3 py-2 text-center",
              i === stages.length - 1
                ? "border-emerald-200 bg-emerald-50/50"
                : "border-slate-200 bg-slate-50/40"
            )}
          >
            <p className="text-[10px] uppercase tracking-wide text-slate-400">{s.label}</p>
            <p className={cn(
              "text-lg font-semibold leading-tight mt-0.5",
              i === stages.length - 1 ? "text-emerald-700" : "text-slate-700"
            )}>
              {s.value}
            </p>
            {s.hint && (
              <p className="text-[10px] text-slate-400 mt-0.5">{s.hint}</p>
            )}
          </div>
        ))}
      </div>

      {noisyQueries && (
        <p className="mt-3 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
          {data.filteredAtSource} of {data.surfaced} surfaced profiles were filtered out before import — your search queries may be too broad. Try Re-analyse.
        </p>
      )}

      {data.rejectedByRecruiter > 0 && (
        <p className="mt-2 text-[11px] text-slate-400">
          {data.rejectedByRecruiter} candidate{data.rejectedByRecruiter !== 1 ? "s" : ""} marked rejected after review.
        </p>
      )}
    </div>
  );
}

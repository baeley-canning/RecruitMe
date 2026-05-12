"use client";

import { useEffect, useState } from "react";
import { TrendingDown, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { CardLoadError } from "@/components/ui/state-pill";

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
    return <CardLoadError message="Couldn't load discovery funnel — refresh to try again." />;
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
    <div className="mb-6 rounded-md border border-separator bg-surface-raised px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <TrendingDown className="w-3.5 h-3.5 text-text-tertiary" />
          <p className="text-md font-semibold text-text-primary">Discovery funnel</p>
        </div>
        {data.shortlisted > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-success bg-success-subtle rounded-sm px-1.5 py-0.5 font-medium">
            <Star className="w-3 h-3" />
            <span className="data-mono">{data.shortlisted}</span> shortlisted
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {stages.map((s, i) => (
          <div
            key={s.label}
            className={cn(
              "rounded border px-3 py-2 text-center",
              i === stages.length - 1
                ? "border-separator-strong bg-success-subtle"
                : "border-separator bg-surface-sunken"
            )}
          >
            <p className="text-2xs uppercase tracking-wide text-text-tertiary">{s.label}</p>
            <p className={cn(
              "text-lg font-semibold leading-tight mt-0.5 data-mono",
              i === stages.length - 1 ? "text-success" : "text-text-primary"
            )}>
              {s.value}
            </p>
            {s.hint && (
              <p className="text-2xs text-text-tertiary mt-0.5">{s.hint}</p>
            )}
          </div>
        ))}
      </div>

      {noisyQueries && (
        <p className="mt-3 text-xs text-warning bg-warning-subtle border-l-2 border-warning rounded-sm px-2 py-1.5">
          <span className="data-mono">{data.filteredAtSource}</span> of <span className="data-mono">{data.surfaced}</span> surfaced profiles were filtered out before import — your search queries may be too broad. Try Re-analyse.
        </p>
      )}

      {/* When searches ran but zero candidates passed scoring — very different from "no searches yet" */}
      {data.searchRuns > 0 && data.imported > 0 && data.scored > 0 && data.shortlisted === 0 && !noisyQueries && (
        <p className="mt-3 text-xs text-text-secondary bg-surface-sunken border border-separator rounded-sm px-2 py-1.5">
          No candidates shortlisted yet — <span className="data-mono">{data.scored}</span> scored, avg <span className="data-mono">{data.avgScore !== null ? `${data.avgScore}%` : "n/a"}</span>. Shortlist the best fits or try Re-analyse to refine requirements.
        </p>
      )}

      {data.rejectedByRecruiter > 0 && (
        <p className="mt-2 text-xs text-text-tertiary">
          <span className="data-mono">{data.rejectedByRecruiter}</span> candidate{data.rejectedByRecruiter !== 1 ? "s" : ""} marked rejected after review.
        </p>
      )}
    </div>
  );
}

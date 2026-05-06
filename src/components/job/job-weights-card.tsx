"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Sliders } from "lucide-react";
import { ScoringWeightsEditor } from "@/components/scoring-weights-editor";
import type { ScoringWeights } from "@/lib/scoring-config";

interface JobScoringResponse {
  weights: ScoringWeights;
  defaults: ScoringWeights;       // platform defaults
  orgDefaults: ScoringWeights;    // org-level (what reset goes back to)
  hasOverride: boolean;
}

// Collapsible per-job override panel. Hidden by default — most jobs use the
// org defaults; this is for the cases where a recruiter wants to lean a
// specific role's scoring (e.g. "for this Sales Director role, location
// matters more than skills").
export function JobWeightsCard({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<JobScoringResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    fetch(`/api/jobs/${jobId}/scoring`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: JobScoringResponse | null) => {
        setData(d);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [open, loaded, jobId]);

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 text-left"
      >
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-medium text-slate-700">Scoring weights for this job</span>
          {data?.hasOverride && (
            <span className="text-[10px] uppercase tracking-wide font-semibold bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5">
              Custom
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="border-t border-slate-100 p-4">
          {!loaded && <p className="text-xs text-slate-400">Loading…</p>}
          {loaded && data && (
            <>
              <p className="text-xs text-slate-500 mb-4">
                Override scoring weights just for this job. Reset returns to your org-level defaults.
              </p>
              <ScoringWeightsEditor
                initialWeights={data.weights}
                defaultWeights={data.orgDefaults}
                saveUrl={`/api/jobs/${jobId}/scoring`}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

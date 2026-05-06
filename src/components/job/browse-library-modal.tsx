"use client";

import { useEffect, useMemo, useState } from "react";
import { X, Loader2, Search, MapPin, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScoreBadge } from "@/components/score-badge";

interface LibraryCandidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  matchScore: number | null;
  createdAt: string;
  job: { title: string } | null;
  archivedJobTitle: string | null;
}

interface BrowseLibraryModalProps {
  jobId: string;
  onComplete: () => void;
  onClose: () => void;
}

// Manual library browser — list, multi-select, then "Add to job".
// Pairs the keyword-based talent-pool route with explicit recruiter intent.
export function BrowseLibraryModal({ jobId, onComplete, onClose }: BrowseLibraryModalProps) {
  const [candidates, setCandidates] = useState<LibraryCandidate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [progress, setProgress] = useState<{ added: number; failed: number } | null>(null);

  useEffect(() => {
    fetch(`/api/jobs/${jobId}/library`)
      .then((r) => r.ok ? r.json() : { candidates: [] })
      .then((d: { candidates: LibraryCandidate[] }) => {
        setCandidates(d.candidates ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [jobId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => {
      const hay = [c.name, c.headline, c.location].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [candidates, query]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleAdd = async () => {
    if (selected.size === 0) return;
    setAdding(true);
    setProgress(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds: [...selected] }),
      });
      const data = await res.json() as { added?: number; failed?: string[] };
      if (res.ok) {
        setProgress({ added: data.added ?? 0, failed: data.failed?.length ?? 0 });
        onComplete();
        // Auto-close after a short success message.
        setTimeout(onClose, 1400);
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[1210] p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="browse-library-title"
        className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h3 id="browse-library-title" className="font-semibold text-slate-900">Add from library</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Browse candidates from across your org and pick people for this job. They&apos;ll be scored automatically.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-3 border-b border-slate-100">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search by name, headline, or location"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-md pl-9 pr-3 py-2 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!loaded && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 text-slate-400 animate-spin" />
            </div>
          )}
          {loaded && filtered.length === 0 && (
            <div className="text-center py-12 text-sm text-slate-400">
              {candidates.length === 0
                ? "Your library is empty. Add candidates from previous jobs first."
                : "No candidates match your search."}
            </div>
          )}
          {loaded && filtered.map((c) => {
            const isSelected = selected.has(c.id);
            return (
              <button
                key={c.id}
                onClick={() => toggle(c.id)}
                className={`w-full text-left px-6 py-3 border-b border-slate-50 hover:bg-slate-50 transition-colors flex items-start gap-3 ${
                  isSelected ? "bg-blue-50/50" : ""
                }`}
              >
                <div className={`mt-1 w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                  isSelected ? "bg-blue-600 border-blue-600" : "border-slate-300"
                }`}>
                  {isSelected && <CheckCircle2 className="w-3 h-3 text-white" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-slate-700 truncate">{c.name}</p>
                    <ScoreBadge score={c.matchScore} size="sm" />
                  </div>
                  {c.headline && (
                    <p className="text-xs text-slate-500 truncate mt-0.5">{c.headline}</p>
                  )}
                  <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-400 flex-wrap">
                    {c.location && (
                      <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{c.location}</span>
                    )}
                    {c.job?.title && (
                      <span className="text-slate-400">from {c.job.title}</span>
                    )}
                    {!c.job?.title && c.archivedJobTitle && (
                      <span className="text-slate-400">archived from {c.archivedJobTitle}</span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            {selected.size} selected
            {progress && (
              <span className="ml-2 text-emerald-600 font-medium">
                · added {progress.added}{progress.failed > 0 ? `, ${progress.failed} failed` : ""}
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button onClick={onClose} size="sm" variant="outline">Cancel</Button>
            <Button
              onClick={handleAdd}
              loading={adding}
              disabled={adding || selected.size === 0}
              size="sm"
            >
              Add {selected.size > 0 ? selected.size : ""} to job
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { X, Loader2, Search, MapPin, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
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
  const [progress, setProgress] = useState<{ added: number; failed: number; unscored?: number } | null>(null);

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
      const data = await res.json() as { added?: number; failed?: string[]; unscoredIds?: string[] };
      if (res.ok) {
        const unscored = data.unscoredIds?.length ?? 0;
        setProgress({
          added: data.added ?? 0,
          failed: data.failed?.length ?? 0,
          unscored,
        });
        onComplete();
        // Keep modal open briefly longer when there are unscored warnings.
        setTimeout(onClose, unscored > 0 ? 3000 : 1400);
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      labelledBy="browse-library-title"
      className="bg-surface-overlay text-text-primary rounded-xl shadow-overlay w-full max-w-2xl max-h-[90vh] flex flex-col"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-separator">
        <div>
          <h3 id="browse-library-title" className="text-md font-semibold text-text-primary">Add from library</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Browse candidates from across your org and pick people for this job. They&apos;ll be scored automatically.
          </p>
        </div>
        <button onClick={onClose} aria-label="Close" className="text-text-tertiary hover:text-text-primary transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-5 py-3 border-b border-separator">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-text-tertiary absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search by name, headline, or location"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full h-7 pl-8 pr-3 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!loaded && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-3.5 h-3.5 text-text-tertiary animate-spin" />
          </div>
        )}
        {loaded && filtered.length === 0 && (
          <div className="text-center py-12 text-base text-text-tertiary">
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
              className={`w-full text-left px-5 py-3 border-b border-separator hover:bg-surface-hover transition-colors flex items-start gap-3 ${
                isSelected ? "bg-accent-subtle" : ""
              }`}
            >
              <div className={`mt-1 w-4 h-4 rounded-sm border flex items-center justify-center flex-shrink-0 ${
                isSelected ? "bg-accent border-accent" : "border-separator-strong"
              }`}>
                {isSelected && <CheckCircle2 className="w-3 h-3 text-white" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-md font-medium text-text-primary truncate">{c.name}</p>
                  <ScoreBadge score={c.matchScore} size="sm" />
                </div>
                {c.headline && (
                  <p className="text-xs text-text-secondary truncate mt-0.5">{c.headline}</p>
                )}
                <div className="flex items-center gap-3 mt-1 text-xs text-text-tertiary flex-wrap">
                  {c.location && (
                    <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{c.location}</span>
                  )}
                  {c.job?.title && (
                    <span>from {c.job.title}</span>
                  )}
                  {!c.job?.title && c.archivedJobTitle && (
                    <span>archived from {c.archivedJobTitle}</span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="px-5 py-3 border-t border-separator flex items-center justify-between gap-3">
        <p className="text-xs text-text-secondary">
          <span className="data-mono">{selected.size}</span> selected
          {progress && (
            <span className="ml-2 text-success font-medium">
              · added <span className="data-mono">{progress.added}</span>{progress.failed > 0 ? <>, <span className="data-mono">{progress.failed}</span> failed</> : ""}{(progress.unscored ?? 0) > 0 ? <> · <span className="data-mono">{progress.unscored}</span> unscored (scoring failed — re-score from job page)</> : ""}
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
    </Modal>
  );
}

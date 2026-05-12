"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, Brain, Trash2, AlertCircle, Loader2 } from "lucide-react";
import { showToast } from "@/components/ui/toast";

interface ScoreCorrection {
  id: string;
  candidateId: string;
  candidate: { name: string; headline: string | null } | null;
  jobId: string | null;
  jobTitle: string | null;
  originalScore: number;
  recruiterScore: number;
  reason: string | null;
  roleTitle: string | null;
  createdAt: string;
}

export function MemoryViewerPage() {
  const [corrections, setCorrections] = useState<ScoreCorrection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/score-corrections", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ScoreCorrection[];
      setCorrections(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load corrections");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = async (id: string) => {
    if (!confirm("Remove this correction from the recruiter memory? It will no longer influence future scoring.")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/settings/score-corrections/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        showToast(data.error || `Delete failed (${res.status})`, "error");
        return;
      }
      setCorrections((prev) => prev?.filter((c) => c.id !== id) ?? null);
      showToast("Correction removed");
    } catch {
      showToast("Network error — try again", "error");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-md text-text-tertiary hover:text-text-primary transition-colors mb-6">
        <ArrowLeft className="w-4 h-4" />
        Back to settings
      </Link>
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 bg-accent-subtle rounded-md flex items-center justify-center">
            <Brain className="w-5 h-5 text-accent" />
          </div>
          <h1 className="text-xl font-semibold text-text-primary">Recruiter memory</h1>
        </div>
        <p className="text-text-secondary text-md ml-12 max-w-2xl">
          Every &quot;this score is wrong&quot; correction you log gets injected into future
          scoring as a calibration example. Remove individual corrections here when
          your thinking has changed.
        </p>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 p-3 bg-danger-subtle border border-separator rounded-md text-md text-danger">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {corrections === null && !error && (
        <div className="flex items-center justify-center py-16 text-text-tertiary">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      )}

      {corrections !== null && corrections.length === 0 && (
        <div className="text-center py-12 bg-surface-raised rounded-md border border-separator border-dashed">
          <Brain className="w-10 h-10 text-text-tertiary mx-auto mb-3" />
          <p className="text-text-secondary text-md font-medium">No corrections logged yet</p>
          <p className="text-text-tertiary text-xs mt-1 max-w-md mx-auto">
            On a candidate card, click &quot;Correct score&quot; to teach the AI when its
            assessment differs from yours. Future similar candidates will be scored
            with your correction in mind.
          </p>
        </div>
      )}

      {corrections !== null && corrections.length > 0 && (
        <div className="bg-surface-raised rounded-md border border-separator overflow-hidden">
          <div className="px-5 py-2.5 border-b border-separator bg-surface-sunken">
            <p className="text-md font-medium text-text-primary">
              {corrections.length} correction{corrections.length !== 1 ? "s" : ""} influencing scoring
            </p>
          </div>
          <div className="divide-y divide-separator">
            {corrections.map((c) => {
              const delta = c.recruiterScore - c.originalScore;
              const deltaLabel = delta > 0 ? `+${delta}` : `${delta}`;
              const deltaColour = delta > 0 ? "text-success bg-success-subtle" : delta < 0 ? "text-danger bg-danger-subtle" : "text-text-secondary bg-surface-hover";
              return (
                <div key={c.id} className="px-5 py-4 hover:bg-surface-hover transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-medium text-md text-text-primary truncate">
                          {c.candidate?.name ?? "Deleted candidate"}
                        </span>
                        <span className="text-xs text-text-tertiary">·</span>
                        <span className="text-xs text-text-secondary">
                          {c.jobTitle ?? c.roleTitle ?? "Unknown role"}
                        </span>
                        <span className="text-xs text-text-tertiary">·</span>
                        <span className="text-xs text-text-tertiary">
                          {new Date(c.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mb-2 text-xs">
                        <span className="text-text-secondary data-mono">AI scored {c.originalScore}%</span>
                        <span className={`font-semibold rounded-sm px-1.5 py-0.5 data-mono ${deltaColour}`}>{deltaLabel}</span>
                        <span className="text-text-secondary data-mono">→ recruiter {c.recruiterScore}%</span>
                      </div>
                      {c.reason && (
                        <p className="text-xs text-text-secondary italic line-clamp-2">&quot;{c.reason}&quot;</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(c.id)}
                      disabled={deletingId === c.id}
                      className="flex-shrink-0 text-text-tertiary hover:text-danger hover:bg-surface-hover p-2 rounded transition-colors"
                      aria-label={`Remove correction for ${c.candidate?.name ?? "candidate"}`}
                      title="Remove this correction"
                    >
                      {deletingId === c.id
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <Trash2 className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

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
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-700 transition-colors mb-6">
        <ArrowLeft className="w-4 h-4" />
        Back to settings
      </Link>
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 bg-violet-50 rounded-lg flex items-center justify-center">
            <Brain className="w-5 h-5 text-violet-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Recruiter memory</h1>
        </div>
        <p className="text-slate-500 text-sm ml-12 max-w-2xl">
          Every &quot;this score is wrong&quot; correction you log gets injected into future
          scoring as a calibration example. Remove individual corrections here when
          your thinking has changed.
        </p>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {corrections === null && !error && (
        <div className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      )}

      {corrections !== null && corrections.length === 0 && (
        <div className="text-center py-12 bg-white rounded-xl border border-slate-200 border-dashed">
          <Brain className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 text-sm font-medium">No corrections logged yet</p>
          <p className="text-slate-400 text-xs mt-1 max-w-md mx-auto">
            On a candidate card, click &quot;Correct score&quot; to teach the AI when its
            assessment differs from yours. Future similar candidates will be scored
            with your correction in mind.
          </p>
        </div>
      )}

      {corrections !== null && corrections.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
            <p className="text-sm font-medium text-slate-700">
              {corrections.length} correction{corrections.length !== 1 ? "s" : ""} influencing scoring
            </p>
          </div>
          <div className="divide-y divide-slate-100">
            {corrections.map((c) => {
              const delta = c.recruiterScore - c.originalScore;
              const deltaLabel = delta > 0 ? `+${delta}` : `${delta}`;
              const deltaColour = delta > 0 ? "text-emerald-700 bg-emerald-50" : delta < 0 ? "text-red-700 bg-red-50" : "text-slate-700 bg-slate-100";
              return (
                <div key={c.id} className="px-5 py-4 hover:bg-slate-50">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-medium text-sm text-slate-900 truncate">
                          {c.candidate?.name ?? "Deleted candidate"}
                        </span>
                        <span className="text-xs text-slate-400">·</span>
                        <span className="text-xs text-slate-500">
                          {c.jobTitle ?? c.roleTitle ?? "Unknown role"}
                        </span>
                        <span className="text-xs text-slate-400">·</span>
                        <span className="text-xs text-slate-500">
                          {new Date(c.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mb-2 text-xs">
                        <span className="text-slate-500">AI scored {c.originalScore}%</span>
                        <span className={`font-semibold rounded px-1.5 py-0.5 ${deltaColour}`}>{deltaLabel}</span>
                        <span className="text-slate-500">→ recruiter {c.recruiterScore}%</span>
                      </div>
                      {c.reason && (
                        <p className="text-xs text-slate-600 italic line-clamp-2">&quot;{c.reason}&quot;</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(c.id)}
                      disabled={deletingId === c.id}
                      className="flex-shrink-0 text-slate-300 hover:text-red-600 hover:bg-red-50 p-2 rounded-md transition-colors"
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

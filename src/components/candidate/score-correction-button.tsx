"use client";

import { useState } from "react";
import { Check, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ScoreCorrectionButtonProps {
  jobId: string;
  candidateId: string;
  currentScore: number | null;
  onSaved?: () => void;
}

// Compact "Score off?" inline editor. Shows a chip; on click expands into a
// score slider + reason textarea + save. Submitting writes a ScoreCorrection
// row that the recruiter-memory layer feeds back into future scoring prompts.
export function ScoreCorrectionButton({
  jobId,
  candidateId,
  currentScore,
  onSaved,
}: ScoreCorrectionButtonProps) {
  const [open, setOpen] = useState(false);
  const [score, setScore] = useState(currentScore ?? 50);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedJustNow, setSavedJustNow] = useState(false);
  const [error, setError] = useState("");

  if (currentScore === null) return null;

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/jobs/${jobId}/candidates/${candidateId}/correct-score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recruiterScore: score, reason: reason.trim() || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(typeof data?.error === "string" ? data.error : "Failed to save.");
        return;
      }
      setSavedJustNow(true);
      setOpen(false);
      onSaved?.();
      setTimeout(() => setSavedJustNow(false), 3000);
    } catch {
      setError("Failed to save. Check your connection.");
    } finally {
      setSaving(false);
    }
  };

  if (savedJustNow) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
        <Check className="w-3 h-3" />
        Correction saved — future scoring will calibrate
      </span>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[10px] text-slate-400 hover:text-blue-600 underline underline-offset-2"
        title="Tell the AI this score is off"
      >
        Score off? Train it
      </button>
    );
  }

  const delta = score - (currentScore ?? 0);

  return (
    <div className="w-full mt-2 p-3 rounded-lg border border-blue-200 bg-blue-50/50 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-slate-700">Train it — what should this score be?</p>
        <button
          onClick={() => { setOpen(false); setError(""); }}
          className="text-slate-300 hover:text-slate-500"
          aria-label="Cancel"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          value={score}
          onChange={(e) => setScore(Number(e.target.value))}
          className="flex-1 accent-blue-600"
        />
        <div className="flex items-baseline gap-1 w-20 flex-shrink-0">
          <span className="text-lg font-semibold text-slate-700">{score}</span>
          <span className={cn(
            "text-[10px] font-medium",
            delta > 0 ? "text-emerald-600" : delta < 0 ? "text-red-600" : "text-slate-400"
          )}>
            {delta === 0 ? "" : `${delta > 0 ? "+" : ""}${delta}`}
          </span>
        </div>
      </div>

      <textarea
        placeholder="Optional — why? (e.g. Strong match but no NZ work rights)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={500}
        className="w-full text-xs border border-slate-200 rounded-md px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      {error && <p className="text-[11px] text-red-600">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-slate-400">
          We&apos;ll use this to calibrate similar roles.
        </p>
        <button
          onClick={handleSave}
          disabled={saving || score === currentScore}
          className="text-xs font-medium px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed inline-flex items-center gap-1"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Save correction
        </button>
      </div>
    </div>
  );
}

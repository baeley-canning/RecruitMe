"use client";

import { useState } from "react";
import { Check, X, Loader2, Pencil } from "lucide-react";
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
      <span className="inline-flex items-center gap-1 text-2xs text-success bg-success-subtle rounded-sm px-2 py-0.5">
        <Check className="w-3 h-3" />
        Correction saved — future scoring will calibrate
      </span>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Train the AI: tell it this score is off"
        className={cn(
          "inline-flex items-center gap-1 h-6 px-2 rounded-sm text-xs font-medium",
          "bg-surface-hover text-text-secondary hover:text-accent hover:bg-accent-subtle",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors",
        )}
      >
        <Pencil className="w-3 h-3" />
        Score off?
      </button>
    );
  }

  const delta = score - (currentScore ?? 0);

  return (
    <div className="w-full mt-2 p-3 rounded-md border border-separator bg-surface-overlay space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-text-primary">Train it — what should this score be?</p>
        <button
          onClick={() => { setOpen(false); setError(""); }}
          className="text-text-tertiary hover:text-text-primary"
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
          className="flex-1 accent-accent"
        />
        <div className="flex items-baseline gap-1 w-20 flex-shrink-0">
          <span className="text-lg font-semibold text-text-primary data-mono">{score}</span>
          <span className={cn(
            "text-2xs font-medium data-mono",
            delta > 0 ? "text-success" : delta < 0 ? "text-text-secondary" : "text-text-tertiary"
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
        className="w-full text-xs border border-separator rounded px-2 py-1.5 bg-surface-sunken text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus"
      />
      <p className="text-2xs text-text-tertiary leading-snug">
        Don&apos;t include health, religion, or other protected info — this reason is sent to the AI scorer.
      </p>

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs text-text-tertiary">
          We&apos;ll use this to calibrate similar roles.
        </p>
        <button
          onClick={handleSave}
          disabled={saving || score === currentScore}
          className="text-xs font-medium px-3 py-1 rounded bg-accent text-text-inverse hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1 transition-colors"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Save correction
        </button>
      </div>
    </div>
  );
}

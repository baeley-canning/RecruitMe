"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, X } from "lucide-react";
import { CopyButton } from "../copy-button";
import { cn } from "@/lib/utils";

interface ProfileTextSectionProps {
  candidate: {
    id: string;
    profileText?: string | null;
    profileCapturedAt?: Date | string | null;
    source?: string | null;
  };
  jobId: string;
  /** Called after successful save so the parent can refresh the candidate row.
   *  When unset we fall back to window.location.reload() — crude but works. */
  onSaved?: () => void;
}

function profileSourceSummary(c: ProfileTextSectionProps["candidate"]): string {
  const chars = c.profileText?.length ?? 0;
  const captured = c.profileCapturedAt
    ? new Date(c.profileCapturedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : null;
  const src = c.source === "extension" ? "LinkedIn extension" : c.source === "talent_pool" ? "Talent pool" : c.source ?? "Manual";
  return `${chars.toLocaleString()} chars · ${src}${captured ? ` · ${captured}` : ""}`;
}

export function ProfileTextSection({ candidate, jobId: _jobId, onSaved }: ProfileTextSectionProps) {
  void _jobId; // currently unused — re-score targets candidate.jobId server-side
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);

  const handleSave = async () => {
    if (!draft.trim()) {
      setError("Paste the missing work history first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/candidates/${candidate.id}/profile-text`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft, mode }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error?.toString?.() ?? json.error ?? "Save failed");
        setSaving(false);
        return;
      }
      const data = await res.json();
      setSuccessNote(
        data.scored
          ? `Saved (${data.profileTextLength.toLocaleString()} chars). Re-scored: ${data.matchScore ?? "—"}.`
          : `Saved (${data.profileTextLength.toLocaleString()} chars). Re-score didn't run — open the candidate again to verify.`,
      );
      setDraft("");
      setEditing(false);
      // router.refresh() re-runs the server component for the current
      // route — gets fresh candidate data WITHOUT reloading the page or
      // closing the drawer. Recruiter sees the updated score inline.
      // Parent-passed onSaved still wins if provided (custom refresh).
      if (onSaved) onSaved();
      else router.refresh();
    } catch {
      setError("Save failed — check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wide">LinkedIn Capture</p>
          <p className="text-xs text-text-tertiary mt-0.5">{profileSourceSummary(candidate)}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {!editing && candidate.profileText && <CopyButton text={candidate.profileText} />}
          {!editing && (
            <button
              type="button"
              onClick={() => { setEditing(true); setSuccessNote(null); setError(null); }}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-separator bg-surface-hover hover:bg-surface-overlay text-text-secondary transition-colors"
              title="Paste missing work history (e.g. older roles the LinkedIn capture didn't pull) and re-score"
            >
              <Pencil className="w-3 h-3" />Add / edit
            </button>
          )}
          {editing && (
            <button
              type="button"
              onClick={() => { setEditing(false); setDraft(""); setError(null); }}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-separator bg-surface-hover hover:bg-surface-overlay text-text-tertiary transition-colors"
            >
              <X className="w-3 h-3" />Cancel
            </button>
          )}
        </div>
      </div>

      {successNote && (
        <div className="mb-2 p-2 rounded border border-separator bg-success-subtle text-xs text-success">
          {successNote}
        </div>
      )}

      {editing ? (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5 text-text-secondary cursor-pointer">
              <input type="radio" name="mode" value="append" checked={mode === "append"} onChange={() => setMode("append")} />
              Append (keep current text + add this below)
            </label>
            <label className="flex items-center gap-1.5 text-text-secondary cursor-pointer">
              <input type="radio" name="mode" value="replace" checked={mode === "replace"} onChange={() => setMode("replace")} />
              Replace (use only this)
            </label>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste missing work history here. e.g. older roles the LinkedIn capture didn't pull, content from a CV, JobAdder history, etc. The candidate will be re-scored against the current job after save."
            rows={12}
            className="w-full p-3 text-xs text-text-primary leading-relaxed bg-surface-sunken border border-separator rounded font-mono focus:outline-none focus:border-accent focus:shadow-focus"
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex items-center justify-between">
            <p className="text-xs text-text-tertiary data-mono">
              {draft.length.toLocaleString()} chars to {mode === "append" ? "append" : "replace existing capture"}.
            </p>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !draft.trim()}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors",
                saving || !draft.trim()
                  ? "bg-surface-hover text-text-tertiary cursor-not-allowed"
                  : "bg-accent hover:bg-accent-hover text-white",
              )}
            >
              {saving ? <><Loader2 className="w-3 h-3 animate-spin" />Saving + re-scoring…</> : "Save & re-score"}
            </button>
          </div>
        </div>
      ) : candidate.profileText ? (
        <div className="p-4 bg-surface-sunken border border-separator rounded-md max-h-[50vh] overflow-y-auto">
          <p className="text-xs text-text-primary leading-relaxed whitespace-pre-wrap">
            {candidate.profileText}
          </p>
        </div>
      ) : (
        <div className="p-4 bg-surface-sunken border border-separator rounded-md text-center">
          <p className="text-sm text-text-tertiary">No profile text captured yet.</p>
          <p className="text-xs text-text-tertiary mt-1">
            Use &ldquo;Fetch profile&rdquo; to pull the full LinkedIn profile, or click &ldquo;Add / edit&rdquo; above to paste a CV or work history manually.
          </p>
        </div>
      )}
    </div>
  );
}

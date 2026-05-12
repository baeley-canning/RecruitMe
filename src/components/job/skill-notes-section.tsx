"use client";

import { Lightbulb, Users, X, Plus, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SkillNote } from "@/lib/ai";

interface SkillNotesSectionProps {
  notes: SkillNote[];
  dismissedSkills: string[];
  niceToHaves: string[];
  pendingAccepted: Set<string>;
  pendingDismissed: Set<string>;
  onAccept: (skill: string, alternative: string) => void;
  onDismiss: (skill: string) => void;
}

export function SkillNotesSection({
  notes,
  dismissedSkills,
  niceToHaves,
  pendingAccepted,
  pendingDismissed,
  onAccept,
  onDismiss,
}: SkillNotesSectionProps) {
  const visible = notes.filter(
    (n) => !dismissedSkills.includes(n.skill) && !pendingDismissed.has(n.skill)
  );

  if (visible.length === 0) return null;

  const isAccepted = (alternative: string) =>
    niceToHaves.some((item) => item.toLowerCase() === alternative.toLowerCase()) ||
    pendingAccepted.has(alternative);

  const legacyNotes  = visible.filter((n) => n.type !== "scarce");
  const scarceNotes  = visible.filter((n) => n.type === "scarce");

  function renderNote(note: SkillNote, isScarce: boolean) {
    const isDismissing = pendingDismissed.has(note.skill);
    const borderCls   = isScarce
      ? "border-l-2 border-l-accent border-separator bg-accent-subtle"
      : "border-l-2 border-l-warning border-separator bg-warning-subtle";
    const textCls     = isScarce ? "text-text-primary" : "text-text-primary";
    const xCls        = "text-text-tertiary hover:text-text-primary";
    const altBase     = isScarce
      ? "bg-surface-raised text-accent border-separator hover:bg-surface-hover"
      : "bg-surface-raised text-warning border-separator hover:bg-surface-hover";
    const altAccepted = "bg-success-subtle text-success border-transparent";
    const altPending  = isScarce
      ? "bg-accent-subtle text-accent border-separator opacity-60"
      : "bg-warning-subtle text-warning border-separator opacity-60";

    return (
      <div key={note.skill} className={cn("rounded border px-3 py-2.5", borderCls)}>
        <div className="flex items-start justify-between gap-2 mb-2">
          <p className={cn("text-xs leading-relaxed", textCls)}>{note.note}</p>
          <button
            onClick={() => onDismiss(note.skill)}
            disabled={isDismissing}
            title="Dismiss this tip"
            className={cn("flex-shrink-0 disabled:opacity-40 transition-colors mt-0.5", xCls)}
          >
            {isDismissing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {note.alternatives.map((alt) => {
            const accepted  = isAccepted(alt);
            const accepting = pendingAccepted.has(alt) && !accepted;
            return (
              <button
                key={alt}
                onClick={() => !accepted && onAccept(note.skill, alt)}
                disabled={accepted || accepting}
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-sm border transition-colors",
                  accepted ? altAccepted : accepting ? cn(altPending, "cursor-wait") : cn(altBase, "cursor-pointer")
                )}
              >
                {accepted ? <Check className="w-2.5 h-2.5" /> : accepting ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Plus className="w-2.5 h-2.5" />}
                {alt}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {legacyNotes.length > 0 && (
        <div>
          <p className="text-2xs font-medium uppercase tracking-wide mb-2 flex items-center gap-1.5 text-warning">
            <Lightbulb className="w-3 h-3" />
            Search Tips
          </p>
          <div className="space-y-3">{legacyNotes.map((n) => renderNote(n, false))}</div>
        </div>
      )}
      {scarceNotes.length > 0 && (
        <div>
          <p className="text-2xs font-medium uppercase tracking-wide mb-2 flex items-center gap-1.5 text-accent">
            <Users className="w-3 h-3" />
            Talent Pool
          </p>
          <div className="space-y-3">{scarceNotes.map((n) => renderNote(n, true))}</div>
        </div>
      )}
    </div>
  );
}

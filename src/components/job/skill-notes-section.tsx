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
    const borderCls   = isScarce ? "border-blue-200 bg-blue-50"   : "border-amber-200 bg-amber-50";
    const textCls     = isScarce ? "text-blue-800"                : "text-amber-800";
    const xCls        = isScarce ? "text-blue-300 hover:text-blue-600" : "text-amber-400 hover:text-amber-600";
    const altBase     = isScarce
      ? "bg-white text-blue-700 border-blue-300 hover:bg-blue-50 hover:border-blue-400"
      : "bg-white text-amber-700 border-amber-300 hover:bg-amber-100 hover:border-amber-400";
    const altAccepted = isScarce
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : "bg-emerald-50 text-emerald-700 border-emerald-200";
    const altPending  = isScarce
      ? "bg-blue-100 text-blue-600 border-blue-300 opacity-60"
      : "bg-amber-100 text-amber-600 border-amber-300 opacity-60";

    return (
      <div key={note.skill} className={cn("rounded-lg border px-3 py-2.5", borderCls)}>
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
                  "inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md border transition-colors",
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
          <p className="text-xs font-medium uppercase tracking-wide mb-2 flex items-center gap-1.5 text-amber-700">
            <Lightbulb className="w-3 h-3" />
            Search Tips
          </p>
          <div className="space-y-3">{legacyNotes.map((n) => renderNote(n, false))}</div>
        </div>
      )}
      {scarceNotes.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide mb-2 flex items-center gap-1.5 text-blue-700">
            <Users className="w-3 h-3" />
            Talent Pool
          </p>
          <div className="space-y-3">{scarceNotes.map((n) => renderNote(n, true))}</div>
        </div>
      )}
    </div>
  );
}

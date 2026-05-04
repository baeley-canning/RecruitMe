"use client";

import { Lightbulb, X, Plus, Check, Loader2 } from "lucide-react";
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

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide mb-2 flex items-center gap-1.5 text-amber-700">
        <Lightbulb className="w-3 h-3" />
        Search Tips
      </p>
      <div className="space-y-3">
        {visible.map((note) => {
          const isDismissing = pendingDismissed.has(note.skill);
          return (
            <div
              key={note.skill}
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5"
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <p className="text-xs text-amber-800 leading-relaxed">{note.note}</p>
                <button
                  onClick={() => onDismiss(note.skill)}
                  disabled={isDismissing}
                  title="Dismiss this tip"
                  className="flex-shrink-0 text-amber-400 hover:text-amber-600 disabled:opacity-40 transition-colors mt-0.5"
                >
                  {isDismissing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <X className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {note.alternatives.map((alt) => {
                  const accepted = isAccepted(alt);
                  const accepting = pendingAccepted.has(alt) && !accepted;
                  return (
                    <button
                      key={alt}
                      onClick={() => !accepted && onAccept(note.skill, alt)}
                      disabled={accepted || accepting}
                      className={cn(
                        "inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md border transition-colors",
                        accepted
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200 cursor-default"
                          : accepting
                            ? "bg-amber-100 text-amber-600 border-amber-300 opacity-60 cursor-wait"
                            : "bg-white text-amber-700 border-amber-300 hover:bg-amber-100 hover:border-amber-400 cursor-pointer"
                      )}
                    >
                      {accepted ? (
                        <Check className="w-2.5 h-2.5" />
                      ) : accepting ? (
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      ) : (
                        <Plus className="w-2.5 h-2.5" />
                      )}
                      {alt}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

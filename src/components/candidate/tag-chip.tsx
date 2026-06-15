import { X } from "lucide-react";
import type { TagDto } from "@/lib/tags";

/**
 * A candidate tag chip. The colour comes from per-tag user data (CandidateTag.color)
 * — the one sanctioned inline-hex in the UI (it's data, not a design token). Pass
 * onRemove to render a removable chip (editor); omit for read-only display.
 */
export function TagChip({ tag, onRemove }: { tag: TagDto; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium border"
      style={{
        backgroundColor: `${tag.color}26`,
        color: tag.color,
        borderColor: `${tag.color}40`,
      }}
    >
      {tag.label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="hover:opacity-70"
          aria-label={`Remove ${tag.label}`}
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </span>
  );
}

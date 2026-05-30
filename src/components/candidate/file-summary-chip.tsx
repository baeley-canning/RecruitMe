import { cn } from "@/lib/utils";
import { FileText, FileType2, Image as ImageIcon, Paperclip } from "lucide-react";

/**
 * Compact file-count chip rendered on candidate list / job-context cards
 * (Phase E). Replaces the binary "CV ✓" / "Cover ✓" badges with actual
 * counts so a recruiter can see at a glance how many documents a candidate
 * has. Categories with zero items are hidden — empty chip → renders null.
 *
 * The CandidateFile.type column uses these string values:
 *   "cv" | "cover_letter" | "photo" | "other"
 *
 * Photos are deliberately surfaced separately (the avatar IS a photo file,
 * so most candidates with a captured photo will show "🖼 1"). Useful for
 * spotting which records have a photo from the JobAdder import.
 */
export interface FileSummaryChipProps {
  files: Array<{ type: string }>;
  /** Tailwind classes merged onto the outer container. */
  className?: string;
}

export function FileSummaryChip({ files, className }: FileSummaryChipProps) {
  let cv = 0;
  let cover = 0;
  let photo = 0;
  let other = 0;
  for (const f of files) {
    if (f.type === "cv") cv += 1;
    else if (f.type === "cover_letter") cover += 1;
    else if (f.type === "photo") photo += 1;
    else other += 1;
  }
  if (cv + cover + photo + other === 0) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-2xs text-text-tertiary",
        className,
      )}
      title={`${cv} CV · ${cover} cover · ${photo} photo · ${other} other`}
    >
      {cv > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <FileText className="w-3 h-3" />
          {cv}
        </span>
      )}
      {cover > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <FileType2 className="w-3 h-3" />
          {cover}
        </span>
      )}
      {photo > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <ImageIcon className="w-3 h-3" />
          {photo}
        </span>
      )}
      {other > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <Paperclip className="w-3 h-3" />
          {other}
        </span>
      )}
    </span>
  );
}

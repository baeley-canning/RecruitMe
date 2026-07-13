"use client";

import { Check, Loader2, Minus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SourceKey, SourceStatus } from "@/lib/search-run";

const META: Record<SourceStatus, { label: string; cls: string; icon: React.ReactNode }> = {
  skipped:  { label: "off",      cls: "bg-surface-hover text-text-tertiary", icon: <Minus className="w-3 h-3" /> },
  pending:  { label: "queued",   cls: "bg-warning-subtle text-warning",      icon: <Loader2 className="w-3 h-3 animate-spin" /> },
  running:  { label: "live",     cls: "bg-warning-subtle text-warning",      icon: <Loader2 className="w-3 h-3 animate-spin" /> },
  complete: { label: "done",     cls: "bg-success-subtle text-success",      icon: <Check className="w-3 h-3" /> },
  failed:   { label: "re-auth",  cls: "bg-danger-subtle text-danger",        icon: <X className="w-3 h-3" /> },
};

function Pill({ source, status, count }: { source: string; status: SourceStatus; count: number }) {
  const m = META[status] ?? META.skipped;
  // Show the count once a source has settled (done/failed) OR has any hits —
  // so "linkedin · done · 0" reads as "scraper ran, found nothing" rather
  // than looking like it was skipped. A genuinely-off source shows "· off".
  const showCount = status === "complete" || status === "failed" || count > 0;
  return (
    <span className={cn("inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm text-xs font-medium", m.cls)}>
      {m.icon}
      <span className="capitalize">{source}</span>
      <span className="opacity-70">· {m.label}</span>
      {showCount && status !== "skipped" && <span className="data-mono opacity-80">· {count}</span>}
    </span>
  );
}

export function SourceStatusPills({
  sources,
  sourceStatus,
  counts,
}: {
  /** Which sources the recruiter actually requested for this run. */
  sources: SourceKey[];
  sourceStatus: { library: SourceStatus; linkedin: SourceStatus; seek: SourceStatus; pdl: SourceStatus };
  counts: { library: number; linkedin: number; seek: number; pdl: number };
}) {
  // Render a pill for every REQUESTED source — including one stuck on
  // "skipped" (scraper off / unavailable), which must show as a muted "off"
  // pill rather than silently vanishing. Sources the user didn't pick get
  // no pill.
  const want = new Set(sources);
  return (
    <div className="flex flex-wrap gap-2">
      {want.has("library") && <Pill source="library" status={sourceStatus.library} count={counts.library} />}
      {want.has("pdl") && <Pill source="pdl" status={sourceStatus.pdl} count={counts.pdl} />}
      {want.has("linkedin") && <Pill source="linkedin" status={sourceStatus.linkedin} count={counts.linkedin} />}
      {want.has("seek") && <Pill source="seek" status={sourceStatus.seek} count={counts.seek} />}
    </div>
  );
}

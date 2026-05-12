"use client";

import { statusLabel, safeParseJson, timeAgo } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

interface StatusEvent {
  status: string;
  changedAt: string;
  changedBy?: string | null;
}

interface CandidateStatusHistoryProps {
  statusHistory: string | null;
}

// Token-based status palette — the legacy lib/utils.statusBadge returns the
// old slate/blue colours which clash with the dark theme; the timeline owns
// its own palette so it stays self-consistent.
function statusPillClass(status: string): string {
  const map: Record<string, string> = {
    new:          "bg-surface-hover text-text-secondary",
    reviewing:    "bg-accent-subtle text-accent",
    shortlisted:  "bg-warning-subtle text-warning",
    contacted:    "bg-llama-subtle text-llama",
    interviewing: "bg-accent-subtle text-accent",
    offer_sent:   "bg-success-subtle text-success",
    hired:        "bg-success-subtle text-success",
    declined:     "bg-warning-subtle text-warning",
    rejected:     "bg-danger-subtle text-danger",
  };
  return map[status] ?? "bg-surface-hover text-text-secondary";
}

export function CandidateStatusHistory({ statusHistory }: CandidateStatusHistoryProps) {
  const history = safeParseJson<StatusEvent[]>(statusHistory, []);
  if (history.length === 0) return null;

  return (
    <div>
      <p className="text-md font-semibold text-text-primary mb-2">History</p>
      {/* Compact timeline: hairline rail with a tiny dot per event */}
      <div className="relative pl-5">
        <div className="absolute left-[7px] top-1.5 bottom-1.5 w-px bg-separator" />
        <ul className="space-y-2">
          {history.map((ev, i) => (
            <li key={i} className="relative flex items-center gap-2">
              {/* Dot — 5px circle on the rail */}
              <span
                className="absolute left-[3px] top-1.5 w-[5px] h-[5px] rounded-full bg-surface-base border border-separator-strong"
                aria-hidden
              />
              <time
                className="data-mono text-xs text-text-tertiary flex-shrink-0 w-20"
                suppressHydrationWarning
              >
                {timeAgo(ev.changedAt)}
              </time>
              <Badge className={statusPillClass(ev.status)}>
                {statusLabel(ev.status)}
              </Badge>
              {ev.changedBy && (
                <span className="text-xs text-text-secondary truncate">{ev.changedBy}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

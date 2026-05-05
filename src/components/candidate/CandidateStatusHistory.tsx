"use client";

import { cn, statusLabel, statusBadge, safeParseJson, timeAgo } from "@/lib/utils";

interface StatusEvent {
  status: string;
  changedAt: string;
}

interface CandidateStatusHistoryProps {
  statusHistory: string | null;
}

export function CandidateStatusHistory({ statusHistory }: CandidateStatusHistoryProps) {
  const history = safeParseJson<StatusEvent[]>(statusHistory, []);
  if (history.length === 0) return null;

  return (
    <div>
      <p className="text-xs font-medium text-slate-600 mb-2">History</p>
      <div className="relative pl-4 space-y-2">
        <div className="absolute left-1.5 top-1 bottom-1 w-px bg-slate-200" />
        {history.map((ev, i) => (
          <div key={i} className="relative flex items-start gap-2">
            <div className="absolute -left-3 top-1 w-2 h-2 rounded-full bg-white border-2 border-slate-300" />
            <div>
              <span className={cn(
                "inline-block text-xs px-1.5 py-0.5 rounded font-medium",
                statusBadge(ev.status)
              )}>
                {statusLabel(ev.status)}
              </span>
              <span className="text-xs text-slate-400 ml-1.5" suppressHydrationWarning>
                {timeAgo(ev.changedAt)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

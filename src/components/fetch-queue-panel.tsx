"use client";

import { useState, useEffect } from "react";
import { X, Loader2, CheckCircle2, AlertCircle, Clock, ChevronDown, ChevronUp, Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";

export type FetchState = "queued" | "waiting" | "fetching" | "done" | "error";

export interface FetchStatus {
  state: FetchState;
  message: string;
  queuePosition?: number;
  startedAt?: number; // epoch ms — set when fetch begins
}

interface FetchQueuePanelProps {
  statuses: Record<string, FetchStatus>;
  candidateNames: Record<string, string>;
  onDismiss: () => void;
  onCancel: (candidateId: string) => void;
}

const STATE_ORDER: FetchState[] = ["fetching", "waiting", "queued", "error", "done"];

// If a session has been waiting/queued this long without advancing, the
// extension is almost certainly not running. Show the install hint.
const EXTENSION_HINT_MS = 15_000;

function useElapsed(startedAt?: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  const mins = Math.floor((now - startedAt) / 60_000);
  const secs = Math.floor(((now - startedAt) % 60_000) / 1_000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export function FetchQueuePanel({ statuses, candidateNames, onDismiss, onCancel }: FetchQueuePanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [now, setNow] = useState(Date.now());

  // Tick once a second so the "stalled session" check below stays live.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const entries = Object.entries(statuses);
  if (entries.length === 0) return null;

  const counts = {
    active:    entries.filter(([, s]) => s.state === "fetching" || s.state === "waiting").length,
    queued:    entries.filter(([, s]) => s.state === "queued").length,
    done:      entries.filter(([, s]) => s.state === "done").length,
    error:     entries.filter(([, s]) => s.state === "error").length,
  };
  const total  = entries.length;
  const pct    = total > 0 ? Math.round((counts.done / total) * 100) : 0;
  const allDone = counts.active === 0 && counts.queued === 0;

  // Show the extension-install hint when something has been stuck waiting
  // for more than EXTENSION_HINT_MS — the extension probably isn't running.
  const showExtensionHint = entries.some(([, s]) =>
    (s.state === "waiting" || s.state === "queued") &&
    s.startedAt !== undefined &&
    now - s.startedAt > EXTENSION_HINT_MS
  );

  // Sort: active first, then queued by position, then errors, then done
  const sorted = [...entries].sort(([, a], [, b]) => {
    const ai = STATE_ORDER.indexOf(a.state);
    const bi = STATE_ORDER.indexOf(b.state);
    if (ai !== bi) return ai - bi;
    if (a.state === "queued" && b.state === "queued") {
      return (a.queuePosition ?? 99) - (b.queuePosition ?? 99);
    }
    return 0;
  });

  return (
    <div className="fixed bottom-6 right-6 z-[1100] w-80 bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden">
      {/* Extension install hint — shown when sessions stall waiting for the extension */}
      {showExtensionHint && (
        <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-50 border-b border-amber-100">
          <Puzzle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-amber-800 font-medium">Browser extension required</p>
            <p className="text-[11px] text-amber-700 mt-0.5">
              Install the RecruitMe LinkedIn Capture extension to fetch profiles.{" "}
              <a href="/linkedin-setup" className="underline font-medium hover:text-amber-900">
                Install instructions
              </a>
            </p>
          </div>
        </div>
      )}
      {/* Header */}
      <div className={cn(
        "flex items-center gap-2 px-4 py-3 border-b border-slate-100",
        allDone ? "bg-emerald-50" : "bg-slate-50"
      )}>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-slate-700">
            {allDone ? "All fetches complete" : `Fetching profiles`}
          </p>
          {!allDone && (
            <p className="text-[11px] text-slate-400 mt-0.5">
              {counts.done}/{total} done
              {counts.active > 0 && ` · ${counts.active} active`}
              {counts.queued > 0 && ` · ${counts.queued} queued`}
            </p>
          )}
        </div>
        {/* Progress bar */}
        {!allDone && (
          <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden flex-shrink-0">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        )}
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-slate-400 hover:text-slate-600 flex-shrink-0"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={onDismiss}
          className="text-slate-400 hover:text-slate-600 flex-shrink-0"
          aria-label="Dismiss completed"
          title="Dismiss — in-progress fetches keep running"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* List */}
      {expanded && (
        <div className="max-h-64 overflow-y-auto divide-y divide-slate-50">
          {sorted.map(([candidateId, status]) => (
            <FetchRow key={candidateId} candidateId={candidateId} status={status} name={candidateNames[candidateId] ?? "Unknown"} onCancel={onCancel} />
          ))}
        </div>
      )}
    </div>
  );
}

function FetchRow({ candidateId, status, name, onCancel }: { candidateId: string; status: FetchStatus; name: string; onCancel: (id: string) => void }) {
  const elapsed = useElapsed(
    (status.state === "waiting" || status.state === "fetching") ? status.startedAt : undefined
  );
  const isActive = status.state === "fetching" || status.state === "waiting";

  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="flex-shrink-0">
        {status.state === "fetching" && <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />}
        {status.state === "waiting"  && <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />}
        {status.state === "queued"   && <Clock   className="w-4 h-4 text-slate-300" />}
        {status.state === "done"     && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
        {status.state === "error"    && <AlertCircle  className="w-4 h-4 text-red-400" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-slate-800 truncate">{name}</p>
        <p className={cn(
          "text-[11px] truncate",
          status.state === "error"  ? "text-red-500" :
          status.state === "done"   ? "text-emerald-600" :
          status.state === "queued" ? "text-slate-400" : "text-slate-500"
        )}>
          {status.state === "queued" && status.queuePosition
            ? `#${status.queuePosition} in queue`
            : status.message}
        </p>
      </div>
      {isActive && elapsed && (
        <span className="text-[10px] text-slate-400 flex-shrink-0 tabular-nums">{elapsed}</span>
      )}
      {status.state !== "done" && (
        <button
          onClick={() => onCancel(candidateId)}
          className="flex-shrink-0 text-slate-300 hover:text-red-500 transition-colors ml-1"
          title="Remove from queue"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

"use client";

import { useState, useEffect } from "react";
import { X, Loader2, CheckCircle2, AlertCircle, ChevronDown, ChevronUp, Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";

export type FetchState = "waiting" | "fetching" | "done" | "error";

export interface FetchStatus {
  state: FetchState;
  message: string;
  startedAt?: number; // epoch ms — set when fetch begins
}

interface FetchQueuePanelProps {
  statuses: Record<string, FetchStatus>;
  candidateNames: Record<string, string>;
  onDismiss: () => void;
  onCancel: (candidateId: string) => void;
}

const STATE_ORDER: FetchState[] = ["fetching", "waiting", "error", "done"];

// If a session has been waiting this long without advancing, the
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
    active: entries.filter(([, s]) => s.state === "fetching" || s.state === "waiting").length,
    done:   entries.filter(([, s]) => s.state === "done").length,
    error:  entries.filter(([, s]) => s.state === "error").length,
  };
  const total  = entries.length;
  const pct    = total > 0 ? Math.round((counts.done / total) * 100) : 0;
  const allDone = counts.active === 0;

  // Show the extension-install hint when something has been stuck waiting
  // for more than EXTENSION_HINT_MS — the extension probably isn't running.
  const showExtensionHint = entries.some(([, s]) =>
    s.state === "waiting" &&
    s.startedAt !== undefined &&
    now - s.startedAt > EXTENSION_HINT_MS
  );

  // Sort: active first, then errors, then done
  const sorted = [...entries].sort(([, a], [, b]) => {
    const ai = STATE_ORDER.indexOf(a.state);
    const bi = STATE_ORDER.indexOf(b.state);
    return ai - bi;
  });

  return (
    <div className="fixed bottom-4 right-4 z-[1100] w-80 bg-surface-overlay border border-separator rounded-md shadow-overlay overflow-hidden">
      {/* Extension install hint — shown when sessions stall waiting for the extension */}
      {showExtensionHint && (
        <div className="flex items-start gap-2 px-3 py-2 bg-warning-subtle border-b border-warning/30">
          <Puzzle className="w-3.5 h-3.5 text-warning flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-warning-hover font-medium">Browser extension required</p>
            <p className="text-xs text-warning-hover/80 mt-0.5">
              Install the RecruitMe LinkedIn Capture extension to fetch profiles.{" "}
              <a href="/linkedin-setup" className="underline font-medium hover:text-warning">
                Install instructions
              </a>
            </p>
          </div>
        </div>
      )}
      {/* Header */}
      <div className={cn(
        "flex items-center gap-2 px-3 py-2 border-b border-separator",
        allDone ? "bg-success-subtle" : "bg-surface-raised",
      )}>
        <div className="flex-1 min-w-0">
          <p className={cn(
            "text-md font-semibold",
            allDone ? "text-success" : "text-text-primary",
          )}>
            {allDone ? "All fetches complete" : "Fetching profiles"}
          </p>
          {!allDone && (
            <p className="text-xs text-text-tertiary mt-0.5">
              <span className="data-mono">{counts.done}/{total}</span> done
              {counts.active > 0 && (
                <>
                  <span className="mx-1">·</span>
                  <span className="data-mono">{counts.active}</span> active
                </>
              )}
            </p>
          )}
        </div>
        {/* Progress bar */}
        {!allDone && (
          <div className="w-16 h-1 bg-separator rounded-full overflow-hidden flex-shrink-0">
            <div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        )}
        <button
          onClick={() => setExpanded((e) => !e)}
          className="h-6 w-6 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={onDismiss}
          className="h-6 w-6 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
          aria-label="Dismiss completed"
          title="Dismiss — in-progress fetches keep running"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* List */}
      {expanded && (
        <div className="max-h-64 overflow-y-auto divide-y divide-separator">
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
    <div className="flex items-center gap-2.5 px-3 py-2">
      <div className="flex-shrink-0">
        {/* Tier colours per spec: pending=warning, processing=accent, complete=success, error=danger */}
        {status.state === "fetching" && <Loader2 className="w-3.5 h-3.5 text-accent  animate-spin" />}
        {status.state === "waiting"  && <Loader2 className="w-3.5 h-3.5 text-warning animate-spin" />}
        {status.state === "done"     && <CheckCircle2 className="w-3.5 h-3.5 text-success" />}
        {status.state === "error"    && <AlertCircle  className="w-3.5 h-3.5 text-danger" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-text-primary truncate">{name}</p>
        <p className={cn(
          "text-xs truncate",
          status.state === "error" ? "text-danger" :
          status.state === "done"  ? "text-success" : "text-text-secondary"
        )}>
          {status.message}
        </p>
      </div>
      {isActive && elapsed && (
        <span className="data-mono text-2xs text-text-tertiary flex-shrink-0">{elapsed}</span>
      )}
      {status.state !== "done" && (
        <button
          onClick={() => onCancel(candidateId)}
          className="flex-shrink-0 h-6 w-6 rounded flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-surface-hover transition-colors"
          title="Remove from queue"
          aria-label={`Remove ${name} from queue`}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

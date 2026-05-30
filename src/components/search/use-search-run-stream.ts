"use client";

import { useEffect, useState } from "react";
import type { RunSnapshot } from "@/lib/search-run";

/**
 * Subscribe to a SearchRun's live SSE feed. Seeded with the server-rendered
 * snapshot so a cold reload paints instantly, then deltas stream in.
 *
 * The stream is a VIEW, not the engine: closing the tab aborts the
 * EventSource server-side (req.signal) but the run keeps progressing in the
 * worker + DB. A terminal initial status means the snapshot is already final
 * — we never open a connection for a finished run.
 */
export function useSearchRunStream(runId: string, initial: RunSnapshot): RunSnapshot {
  const [state, setState] = useState<RunSnapshot>(initial);

  useEffect(() => {
    if (initial.run.status !== "queued" && initial.run.status !== "running") return;
    const es = new EventSource(`/api/search/${runId}/stream`);
    es.addEventListener("run", (e) => {
      try {
        const snap = JSON.parse((e as MessageEvent).data) as RunSnapshot;
        // The tick omits `results` when the run is unchanged — keep the prior set.
        setState((prev) => (snap.results === undefined ? { ...prev, run: snap.run } : snap));
        if (snap.run.status !== "queued" && snap.run.status !== "running") es.close();
      } catch {
        /* malformed frame — ignore, next tick recovers */
      }
    });
    es.onerror = () => {
      /* EventSource auto-reconnects on transient drops; nothing to do */
    };
    return () => es.close();
  }, [runId, initial.run.status]);

  return state;
}

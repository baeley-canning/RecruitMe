"use client";

import { useState } from "react";
import type { RunSnapshot } from "@/lib/search-run";
import { useRunSnapshotStream } from "./use-run-snapshot-stream";

/**
 * Subscribe to a SearchRun's live SSE feed. Seeded with the server-rendered
 * snapshot so a cold reload paints instantly, then deltas stream in.
 *
 * The stream is a VIEW, not the engine: closing the tab aborts the
 * EventSource server-side (req.signal) but the run keeps progressing in the
 * worker + DB. A terminal initial status means the snapshot is already final
 * — we never open a connection for a finished run.
 *
 * The EventSource lifecycle itself lives in [[useRunSnapshotStream]] so this
 * view and the job search modal share one canonical stream implementation.
 */
export function useSearchRunStream(runId: string, initial: RunSnapshot): RunSnapshot {
  const [state, setState] = useState<RunSnapshot>(initial);

  const live = initial.run.status === "queued" || initial.run.status === "running";
  useRunSnapshotStream(runId, live, (snap) => {
    // The tick omits `results` when the run is unchanged — keep the prior set.
    setState((prev) => (snap.results === undefined ? { ...prev, run: snap.run } : snap));
  });

  return state;
}

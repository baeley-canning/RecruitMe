"use client";

import { useEffect, useRef } from "react";
import type { RunSnapshot } from "@/lib/search-run";

/**
 * Low-level SearchRun SSE primitive: the ONE place that owns the EventSource
 * lifecycle for `/api/search/[runId]/stream`.
 *
 * Both the standalone run view (via [[useSearchRunStream]]) and the job search
 * modal previously hand-rolled this exact connection — open the stream, parse
 * each `run` frame into a RunSnapshot, and close on a terminal status. Two
 * copies of the "when do we close the socket" rule is exactly the kind of
 * duplicate live state the SearchRun engine is supposed to make canonical, so
 * the mechanics live here and callers just say what to do with each snapshot.
 *
 * It is a VIEW, not the engine: unmount/close aborts the socket server-side
 * (req.signal), but the run keeps progressing in the worker + DB. When `active`
 * is false (a terminal/absent run) no connection is opened at all.
 *
 * @param runId   the run to stream, or null when there's nothing to watch
 * @param active  open the socket only while the run can still change
 * @param onSnapshot called for each `run` frame; a tick may omit `results`
 *                   (unchanged) so callers must keep their prior set in that case
 */
export function useRunSnapshotStream(
  runId: string | null,
  active: boolean,
  onSnapshot: (snap: RunSnapshot) => void,
): void {
  // Keep the latest callback in a ref so a caller passing an inline closure
  // doesn't churn the effect (and reopen the socket) on every render.
  const cbRef = useRef(onSnapshot);
  cbRef.current = onSnapshot;

  useEffect(() => {
    if (!runId || !active) return;
    const es = new EventSource(`/api/search/${runId}/stream`);
    es.addEventListener("run", (e) => {
      try {
        const snap = JSON.parse((e as MessageEvent).data) as RunSnapshot;
        cbRef.current(snap);
        // Close as soon as the run reaches a terminal status — the same rule
        // both callers relied on, now in one place.
        if (snap.run.status !== "queued" && snap.run.status !== "running") es.close();
      } catch {
        /* malformed frame — ignore, the next tick recovers */
      }
    });
    es.onerror = () => {
      /* EventSource auto-reconnects on transient drops; nothing to do */
    };
    return () => es.close();
  }, [runId, active]);
}

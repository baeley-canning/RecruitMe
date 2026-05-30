/**
 * GET /api/search/[runId]/stream — SSE live updates for a search run.
 *
 * In-process tick (NO HTTP hairpin — that deadlocks the pool under an open
 * SSE stream, the bug we already hit on the box dashboard). Cheap: each tick
 * loads only the run row; the result set is re-fetched only when the run's
 * updatedAt changed since the last tick. Closes instantly when the run hits a
 * terminal status, and after a hard 15-min max lifetime so a never-settling
 * run can't pin a connection forever.
 *
 * SSE is a VIEW, not the engine — closing the tab aborts only this stream;
 * the run keeps progressing in the worker + DB. Excluded from Caddy gzip
 * (the stream path is routed through the no-compress handler).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { assertRunAccess, loadRunSnapshot } from "@/lib/search-run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TICK_MS = 2_000;
const HEARTBEAT_MS = 25_000;
const MAX_LIFETIME_MS = 15 * 60 * 1000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { runId } = await params;

  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  const ok = await assertRunAccess(runId, { isOwner: auth.isOwner, accessibleOrgIds });
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastUpdatedAt = -1;
      // Holder so cleanup() can clear the intervals via a stable const ref
      // (the intervals are assigned after tick/cleanup are defined).
      const timers: { tick?: ReturnType<typeof setInterval>; hb?: ReturnType<typeof setInterval> } = {};
      const cleanup = () => {
        closed = true;
        if (timers.tick) clearInterval(timers.tick);
        if (timers.hb) clearInterval(timers.hb);
        try { controller.close(); } catch { /* already closed */ }
      };

      const tick = async () => {
        if (closed) return;
        try {
          const snap = await loadRunSnapshot(runId, { sinceUpdatedAt: lastUpdatedAt < 0 ? undefined : lastUpdatedAt });
          if (!snap) { cleanup(); return; }
          lastUpdatedAt = snap.run.updatedAtMs;
          controller.enqueue(encoder.encode(`event: run\ndata: ${JSON.stringify(snap)}\n\n`));
          const terminal = !["queued", "running"].includes(snap.run.status);
          if (terminal || Date.now() - startedAt > MAX_LIFETIME_MS) cleanup();
        } catch {
          // transient DB blip — keep the stream open, retry next tick
        }
      };

      await tick();
      timers.tick = setInterval(tick, TICK_MS);
      timers.hb = setInterval(() => {
        if (!closed) {
          try { controller.enqueue(encoder.encode(`: keepalive\n\n`)); } catch { /* closed */ }
        }
      }, HEARTBEAT_MS);
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

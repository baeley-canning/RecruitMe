/**
 * GET /api/watches/feed/stream — SSE live feed of profile-update hits.
 *
 * Profile-Update Alerts (Stage D). Gated on isProfileWatchEnabled() — 404 when
 * off so the feature ships dark.
 *
 * In-process tick (NO HTTP hairpin — that deadlocks the pool under an open SSE
 * stream; copied verbatim from /api/search/[runId]/stream). Each tick runs
 * lazy hit-detection for the org (settles any processed-but-not-detected watch
 * run), reads the org's recent hits + unseen count, and emits a `feed` event
 * only when the snapshot's signature changes (newest flaggedAt + row count +
 * unseen) so an idle feed is near-silent. A 25s keepalive holds the connection
 * open through proxies; a 30-min hard max-lifetime stops a forgotten tab from
 * pinning a connection forever.
 *
 * SSE is a VIEW, not the engine — closing the tab aborts only this stream; the
 * watches keep running server-side. Excluded from Caddy gzip via X-Accel-Buffering.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { isProfileWatchEnabled } from "@/lib/feature-flags";
import { detectHitsForOrg, listHits, countUnseenHits } from "@/lib/watched-search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TICK_MS = 5_000;
const HEARTBEAT_MS = 25_000;
const MAX_LIFETIME_MS = 30 * 60 * 1000;

export async function GET(req: NextRequest) {
  if (!isProfileWatchEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const orgId = auth.orgId;
  // No org → nothing to stream; emit one empty snapshot and close so the client
  // renders its empty state without hanging on an open connection.
  const url = new URL(req.url);
  const watchId = url.searchParams.get("watchId") || undefined;

  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastSig = "";
      const timers: { tick?: ReturnType<typeof setInterval>; hb?: ReturnType<typeof setInterval> } = {};
      const cleanup = () => {
        closed = true;
        if (timers.tick) clearInterval(timers.tick);
        if (timers.hb) clearInterval(timers.hb);
        try { controller.close(); } catch { /* already closed */ }
      };

      const emit = (payload: unknown) => {
        try { controller.enqueue(encoder.encode(`event: feed\ndata: ${JSON.stringify(payload)}\n\n`)); }
        catch { /* closed */ }
      };

      if (!orgId) {
        emit({ hits: [], unseen: 0 });
        cleanup();
        return;
      }

      const tick = async () => {
        if (closed) return;
        try {
          // Settle any processed-but-not-detected runs, then read the ledger.
          await detectHitsForOrg(orgId, watchId).catch(() => {});
          const [hits, unseen] = await Promise.all([
            listHits(orgId, { watchId, limit: 200 }),
            countUnseenHits(orgId),
          ]);
          const sig = `${hits.length}:${unseen}:${hits[0]?.id ?? ""}:${hits[0]?.flaggedAt ?? ""}`;
          if (sig !== lastSig) {
            lastSig = sig;
            emit({ hits, unseen });
          }
          if (Date.now() - startedAt > MAX_LIFETIME_MS) cleanup();
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

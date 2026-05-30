/**
 * GET /api/box-dashboard/stream — Server-Sent Events feed of box vitals.
 *
 * Every 10s emits a `stats` event with the collectBoxStats() payload.
 * The on-box kiosk page subscribes via EventSource; the browser auto-
 * reconnects if the connection drops (app restart, blip).
 *
 * IMPORTANT: collects stats by calling collectBoxStats() DIRECTLY in
 * process — NOT by HTTP-fetching /api/box-dashboard/stats. The hairpin
 * (Next → Caddy → Next) deadlocks the connection pool while a browser
 * holds the SSE stream open, which silently starves the EventSource
 * (connection opens, zero data events). Direct call fixes that.
 *
 * Auth: same loopback / Tailscale middleware gate as the stats route.
 */

import { NextRequest } from "next/server";
import { collectBoxStats } from "@/lib/box-stats";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TICK_MS = 10_000;

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = async () => {
        if (closed) return;
        try {
          const stats = await collectBoxStats();
          controller.enqueue(encoder.encode(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`));
        } catch (err) {
          const msg = err instanceof Error ? err.message : "stats failed";
          controller.enqueue(encoder.encode(`event: stats-error\ndata: ${JSON.stringify({ msg })}\n\n`));
        }
      };

      // Immediate first paint, then steady cadence.
      await send();
      const timer = setInterval(send, TICK_MS);

      // Keepalive comment every 25s so intermediate proxies don't idle-close.
      const heartbeat = setInterval(() => {
        if (!closed) {
          try { controller.enqueue(encoder.encode(`: keepalive\n\n`)); } catch { /* closed */ }
        }
      }, 25_000);

      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(timer);
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      });
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

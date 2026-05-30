/**
 * GET /api/box-dashboard/stats — one-shot snapshot of box vitals + activity.
 *
 * Thin wrapper over collectBoxStats() (src/lib/box-stats.ts). The SSE
 * stream route calls the same collector IN-PROCESS rather than HTTP-
 * fetching this route (avoids a Caddy→Next hairpin deadlock under an
 * open EventSource).
 *
 * Auth: gated by middleware to loopback + Tailscale CGNAT only.
 */

import { NextResponse } from "next/server";
import { collectBoxStats } from "@/lib/box-stats";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const stats = await collectBoxStats();
  return NextResponse.json(stats, { headers: { "cache-control": "no-store" } });
}

/**
 * GET /api/admin/scraper-queues — owner-only per-queue scraper visibility.
 *
 * Returns the box's job matrix (ScrapeJob.kind × platform) with pending /
 * processing depth, oldest-pending age, and last ok/fail per queue. Counts +
 * timestamps only, no PII. Powers the Admin "Appliance status" control surface.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getScraperQueueStats } from "@/lib/scraper-queues";

type AnySession = { user?: { role?: string } } | null;

export async function GET() {
  const session = (await getServerSession(authOptions)) as AnySession;
  if (session?.user?.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  const stats = await getScraperQueueStats();
  return NextResponse.json(stats);
}

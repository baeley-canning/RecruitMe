/**
 * POST /api/admin/scraper-queues/refresh — owner manually triggers a
 * refresh_known_profile sweep (the same one the hourly scheduler runs).
 *
 * This is the "Run refresh sweep" button on the Appliance control surface: a
 * deliberate owner action, so it's gated on the owner session (not the cron
 * secret) and only requires isScraperEnabled (there must be a box to do the
 * fetches) — NOT the scheduler flag, since the owner is explicitly asking for a
 * one-off run. Library-safe: enqueueStaleProfileRefresh only enqueues background
 * re-fetch jobs; it never mutates or deletes candidates.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isScraperEnabled } from "@/lib/feature-flags";
import { enqueueStaleProfileRefresh } from "@/lib/profile-refresh";

type AnySession = { user?: { role?: string } } | null;

/** Optional bounded-run overrides so an owner can fire a small explicit test
 *  sweep (e.g. 2 profiles / 60-day window) without moving the prod defaults. */
const BodySchema = z.object({
  staleAfterDays: z.number().int().min(1).max(3650).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export async function POST(req: Request) {
  const session = (await getServerSession(authOptions)) as AnySession;
  if (session?.user?.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  if (!isScraperEnabled()) {
    return NextResponse.json({ error: "Scraper not enabled — no worker to run the sweep." }, { status: 409 });
  }
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  const summary = await enqueueStaleProfileRefresh(parsed.success ? parsed.data : {});
  return NextResponse.json({ ok: true, ...summary });
}

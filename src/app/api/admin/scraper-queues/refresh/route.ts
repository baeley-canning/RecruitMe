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
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isScraperEnabled } from "@/lib/feature-flags";
import { enqueueStaleProfileRefresh } from "@/lib/profile-refresh";

type AnySession = { user?: { role?: string } } | null;

export async function POST() {
  const session = (await getServerSession(authOptions)) as AnySession;
  if (session?.user?.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  if (!isScraperEnabled()) {
    return NextResponse.json({ error: "Scraper not enabled — no worker to run the sweep." }, { status: 409 });
  }
  const summary = await enqueueStaleProfileRefresh();
  return NextResponse.json({ ok: true, ...summary });
}

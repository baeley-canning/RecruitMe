/**
 * POST /api/refresh/run-due — scheduler sweep for refresh_known_profile.
 *
 * Enqueues background re-fetch jobs for the stalest LinkedIn profiles already in
 * the library (see src/lib/profile-refresh.ts), keeping the owned library fresh
 * without any live discovery or vendor spend.
 *
 * This route holds the scheduler LOGIC only; the in-process timer in
 * instrumentation.ts drives it (and a box/Railway cron may too). It ships DARK:
 * gated on BOTH isProfileRefreshEnabled() AND isScraperEnabled(), so it 404s
 * unless the flags are on and there's a worker to do the fetches.
 *
 * Auth: x-cron-secret, timing-safe against CONTACT_SYNC_CRON_SECRET — the same
 * cron-secret shape as /api/watches/run-due, so the two cron entrypoints share
 * one credential.
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { isProfileRefreshEnabled, isScraperEnabled } from "@/lib/feature-flags";
import { enqueueStaleProfileRefresh } from "@/lib/profile-refresh";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function timingSafe(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(req: Request) {
  // Ships dark: both flags must be on (and a worker must be enabled), else the
  // route doesn't exist.
  if (!isProfileRefreshEnabled() || !isScraperEnabled()) return notFound();

  const cronOk = timingSafe(req.headers.get("x-cron-secret"), process.env.CONTACT_SYNC_CRON_SECRET);
  if (!cronOk) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const summary = await enqueueStaleProfileRefresh();
  return NextResponse.json({ ok: true, now: new Date().toISOString(), ...summary });
}

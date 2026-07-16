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
import { z } from "zod";
import { timingSafeEqual } from "crypto";
import { isProfileRefreshEnabled, isScraperEnabled } from "@/lib/feature-flags";
import { enqueueStaleProfileRefresh } from "@/lib/profile-refresh";

/** Optional bounded-run overrides — lets an operator fire a small, explicit test
 *  sweep (e.g. 2 profiles at a 60-day window) without changing the prod
 *  defaults. Omitted → the env/default behaviour the scheduler uses. */
const BodySchema = z.object({
  staleAfterDays: z.number().int().min(1).max(3650).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

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

  // Body is optional — the scheduler POSTs none and gets default behaviour.
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  const opts = parsed.success ? parsed.data : {};

  const summary = await enqueueStaleProfileRefresh(opts);
  return NextResponse.json({ ok: true, now: new Date().toISOString(), ...summary });
}

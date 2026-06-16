/**
 * GET   /api/watches/feed — the profile-update feed for the caller's org.
 * PATCH /api/watches/feed — mark feed rows seen.
 *
 * Profile-Update Alerts (Stage D). Gated on isProfileWatchEnabled() — 404 when
 * off so the feature ships dark (the feed UI + the bell line both consume this,
 * so a 404 here is what keeps them inert when the flag is off).
 *
 * Org-scoped: every read/write filters by the caller's orgId; the ledger rows
 * carry a non-null orgId so a watchId from another org can't leak rows.
 *
 * On GET we first run LAZY hit-detection (detectHitsForOrg): any of the org's
 * watches whose lastRunId points at a now-SETTLED SearchRun gets its SEEK
 * result rows turned into hits before we read the ledger. detectHits is
 * idempotent, so this is a cheap no-op once a run is processed — it means a
 * recruiter who opens /updates after leaving the tab sees hits from a check
 * that settled while they were away, with no scheduler in the loop.
 *
 * ?count=1 returns just { unseen } (the bell's COUNT — no Reminder rows).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuth, unauthorized } from "@/lib/session";
import { isProfileWatchEnabled } from "@/lib/feature-flags";
import {
  detectHitsForOrg,
  listHits,
  countUnseenHits,
  markHitsSeen,
} from "@/lib/watched-search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET(req: Request) {
  if (!isProfileWatchEnabled()) return notFound();
  const auth = await getAuth();
  if (!auth) return unauthorized();
  // No org → no watches, no ledger. Return an empty (count) payload so the bell
  // and feed render their empty state instead of erroring.
  if (!auth.orgId) {
    const url = new URL(req.url);
    if (url.searchParams.get("count") === "1") return NextResponse.json({ unseen: 0 });
    return NextResponse.json({ hits: [], unseen: 0 });
  }

  const url = new URL(req.url);
  const watchId = url.searchParams.get("watchId") || undefined;
  const countOnly = url.searchParams.get("count") === "1";

  // Bell COUNT path: cheap, no lazy detection (the feed page does the detection
  // on open; the bell just reflects the current unseen total on its 60s poll).
  if (countOnly) {
    const unseen = await countUnseenHits(auth.orgId);
    return NextResponse.json({ unseen });
  }

  // Feed path: lazily settle any processed-but-not-yet-detected runs first.
  try {
    await detectHitsForOrg(auth.orgId, watchId);
  } catch {
    // Detection is best-effort on read — never fail the feed because a single
    // run's rows couldn't be parsed; the ledger we already have still renders.
  }

  const [hits, unseen] = await Promise.all([
    listHits(auth.orgId, { watchId, limit: 200 }),
    countUnseenHits(auth.orgId),
  ]);
  return NextResponse.json({ hits, unseen });
}

const PatchSchema = z
  .object({
    ids: z.array(z.string()).max(500).optional(),
    watchId: z.string().optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.all === true || (v.ids && v.ids.length > 0) || v.watchId, {
    message: "Provide ids, watchId, or all:true",
  });

export async function PATCH(req: Request) {
  if (!isProfileWatchEnabled()) return notFound();
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return NextResponse.json({ updated: 0 });

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  const { ids, watchId, all } = parsed.data;
  // all:true clears the whole org feed (optionally narrowed by watchId). ids
  // marks a specific subset. Both stay org-scoped inside markHitsSeen.
  const updated = await markHitsSeen(auth.orgId, {
    ids: all ? undefined : ids,
    watchId,
  });
  return NextResponse.json({ updated });
}

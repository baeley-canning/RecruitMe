/**
 * POST /api/watches/[id]/check — manually trigger one check of a watch.
 *
 * Profile-Update Alerts (Stage C). Gated on isProfileWatchEnabled() — 404 when
 * off. Org-scoped: the watch is loaded by (id, orgId) so another org's id 404s.
 * Reuses enqueueWatchCheck → a SEEK-only SearchRun + a priority-50 SEEK search
 * job; returns the runId so the caller can stream the run / lazily detect hits
 * off it once the worker harvests. The recruiter can leave the tab — the run is
 * durable (the mandated server-side convergence).
 */

import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { isProfileWatchEnabled } from "@/lib/feature-flags";
import { getWatch, enqueueWatchCheck } from "@/lib/watched-search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isProfileWatchEnabled()) return notFound();
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return notFound();

  const { id } = await ctx.params;
  const watch = await getWatch(id, auth.orgId);
  if (!watch) return notFound();

  const { runId, jobId } = await enqueueWatchCheck({
    id: watch.id,
    orgId: watch.orgId,
    jobId: watch.jobId,
    query: watch.query,
    location: watch.location,
    intervalMinutes: watch.intervalMinutes,
  });

  return NextResponse.json({ runId, jobId }, { status: 202 });
}

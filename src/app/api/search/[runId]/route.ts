/**
 * GET /api/search/[runId] — full run state + all results so far.
 *
 * The durable re-entry point: server-renders the snapshot on cold reload
 * regardless of whether the originating tab is open. Org-scoped; 404 for
 * runs outside the caller's accessible orgs (don't leak existence).
 */

import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { assertRunAccess, loadRunSnapshot } from "@/lib/search-run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { runId } = await params;

  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  const ok = await assertRunAccess(runId, { isOwner: auth.isOwner, accessibleOrgIds });
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const snapshot = await loadRunSnapshot(runId);
  if (!snapshot) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ run: snapshot.run, results: snapshot.results ?? [] });
}

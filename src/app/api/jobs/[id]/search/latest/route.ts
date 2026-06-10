/**
 * GET /api/jobs/[id]/search/latest — the job's most recent durable SearchRun.
 *
 * Lets the job page resume "this job's last search" on load: if a recent run
 * exists it returns a light summary (id + status + counts) so the page can show
 * an in-progress banner or a "view last search" affordance, then open the modal
 * against that run (which re-fetches the full snapshot + streams live updates).
 *
 * Returns { run: null } when the job has never been searched — NOT a 404, so the
 * client can branch without treating "no search yet" as an error.
 */

import { NextResponse } from "next/server";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  // Job access also gates run access: a run is jobId-scoped, so whoever can see
  // the job can see its searches. (Runs carry the job's orgId too.)
  const { error: accessError } = await requireJobAccess(id, auth);
  if (accessError) return accessError;

  const run = await prisma.searchRun.findFirst({
    where: { jobId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      rawQuery: true,
      libraryStatus: true,
      linkedinStatus: true,
      seekStatus: true,
      totalCount: true,
      libraryCount: true,
      linkedinCount: true,
      seekCount: true,
      createdAt: true,
      completedAt: true,
    },
  });

  if (!run) return NextResponse.json({ run: null });

  return NextResponse.json({
    run: {
      id: run.id,
      status: run.status,
      rawQuery: run.rawQuery,
      sourceStatus: {
        library: run.libraryStatus,
        linkedin: run.linkedinStatus,
        seek: run.seekStatus,
      },
      counts: {
        total: run.totalCount,
        library: run.libraryCount,
        linkedin: run.linkedinCount,
        seek: run.seekCount,
      },
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    },
  });
}

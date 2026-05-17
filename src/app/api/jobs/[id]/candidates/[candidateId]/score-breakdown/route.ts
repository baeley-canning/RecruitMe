import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";

// Lazy-load endpoint for the per-candidate scoreBreakdown JSON. The job page
// (GET /api/jobs/:id) used to ship this field for every candidate in the
// relation, which on a 500-candidate job was ~2-5MB on every page load. The
// breakdown is only needed when the recruiter opens the "Why?" panel on a
// specific candidate card, so candidate-card.tsx now fetches it from here
// on demand. Returns the raw stringified JSON (same shape the card already
// parses via safeParseJson) so the consumer doesn't have to change.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;
  const { error } = await requireCandidateAccess(id, candidateId, auth);
  if (error) return error;

  const row = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { scoreBreakdown: true },
  });
  // requireCandidateAccess already 404s if the candidate doesn't exist for
  // this job, so a null row here would be a race (candidate deleted between
  // the auth check and the findUnique). Treat it as 404 for consistency.
  if (!row) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  return NextResponse.json({ scoreBreakdown: row.scoreBreakdown });
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

async function requireCandidateLibraryAccess(
  candidateId: string,
  auth: Awaited<ReturnType<typeof getAuth>>
) {
  if (!auth) return { candidate: null, error: unauthorized() };

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    include: {
      job: { select: { id: true, title: true, company: true, orgId: true } },
      files: {
        select: { id: true, type: true, filename: true, mimeType: true, size: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!candidate) {
    return { candidate: null, error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  // candidate.orgId is the canonical org per schema.prisma — "copied from
  // job.orgId on create; preserved after job deletion for auth scoping". Job
  // is only consulted when the candidate row predates the orgId column.
  // Reversing this priority let cross-org notes leak whenever a job's
  // orgId disagreed with the candidate's preserved orgId.
  const orgId = candidate.orgId ?? candidate.job?.orgId ?? null;
  if (!auth.isOwner && orgId !== auth.orgId) {
    return { candidate: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  // Defence in depth: if job.orgId disagrees with the canonical orgId, the
  // row's history is suspect — strip the sensitive freeform fields rather
  // than risk leaking another org's notes.
  if (
    candidate.job?.orgId &&
    candidate.orgId &&
    candidate.job.orgId !== candidate.orgId &&
    !auth.isOwner
  ) {
    candidate.notes = null;
    candidate.screeningData = null;
    candidate.interviewNotes = null;
    candidate.statusHistory = null;
  }
  return { candidate, error: null };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { candidate, error } = await requireCandidateLibraryAccess(id, auth);
  if (error) return error;

  // Also fetch all other jobs this person appears in (by LinkedIn URL).
  let otherJobs: { id: string; title: string; company: string | null; matchScore: number | null; status: string }[] = [];
  if (candidate!.linkedinUrl) {
    const others = await prisma.candidate.findMany({
      where: {
        linkedinUrl: candidate!.linkedinUrl,
        id: { not: id },
        ...(auth.isOwner ? {} : { OR: [{ job: { orgId: auth.orgId } }, { jobId: null, orgId: auth.orgId }] }),
      },
      select: {
        matchScore: true,
        status: true,
        job: { select: { id: true, title: true, company: true } },
      },
    });
    otherJobs = others.flatMap((o) => o.job ? [{
      id: o.job.id,
      title: o.job.title,
      company: o.job.company,
      matchScore: o.matchScore,
      status: o.status,
    }] : []);
  }

  return NextResponse.json({ ...candidate, otherJobs });
}

const PatchSchema = z.object({
  notes: z.string().max(10_000).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { candidate, error } = await requireCandidateLibraryAccess(id, auth);
  if (error) return error;
  void candidate;

  const result = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 422 });

  const updated = await prisma.candidate.update({
    where: { id },
    data: result.data,
  });
  return NextResponse.json(updated);
}

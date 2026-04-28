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
  const orgId = candidate.job?.orgId ?? candidate.orgId;
  if (!auth.isOwner && orgId !== auth.orgId) {
    return { candidate: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
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

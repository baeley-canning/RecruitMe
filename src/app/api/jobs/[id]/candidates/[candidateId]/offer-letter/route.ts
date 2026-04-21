import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateOfferLetter } from "@/lib/ai";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;
  const { error } = await requireCandidateAccess(id, candidateId, auth);
  if (error) return error;

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      name: true,
      job: { select: { title: true, company: true, salaryMin: true, salaryMax: true } },
    },
  });

  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  const salary = (candidate.job.salaryMin || candidate.job.salaryMax)
    ? { min: candidate.job.salaryMin ?? undefined, max: candidate.job.salaryMax ?? undefined }
    : null;

  const letter = await generateOfferLetter(
    candidate.name,
    candidate.job.title,
    candidate.job.company,
    salary
  );

  return NextResponse.json(letter);
}

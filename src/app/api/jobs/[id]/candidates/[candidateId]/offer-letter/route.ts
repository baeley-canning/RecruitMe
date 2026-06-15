import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateOfferLetter } from "@/lib/ai";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";
import { checkSpendCap } from "@/lib/usage";

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

  if (!candidate || !candidate.job) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  const spend = await checkSpendCap(auth.orgId);
  if (!spend.allowed) {
    return NextResponse.json(
      { error: `Daily AI spend cap reached ($${spend.spentUsd.toFixed(2)} / $${spend.capUsd.toFixed(2)}). Try again tomorrow or raise AI_DAILY_SPEND_CAP_USD.` },
      { status: 429 },
    );
  }

  const salary = (candidate.job.salaryMin || candidate.job.salaryMax)
    ? { min: candidate.job.salaryMin ?? undefined, max: candidate.job.salaryMax ?? undefined }
    : null;

  const letter = await generateOfferLetter(
    candidate.name,
    candidate.job.title,
    candidate.job.company,
    salary,
    undefined, // startDate
    { orgId: auth.orgId, userId: auth.userId },
  );

  return NextResponse.json(letter);
}

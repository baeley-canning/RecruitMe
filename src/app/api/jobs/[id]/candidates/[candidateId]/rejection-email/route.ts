import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateRejectionEmail } from "@/lib/ai";
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
    select: { name: true, notes: true, job: { select: { title: true, company: true } } },
  });

  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  const email = await generateRejectionEmail(
    candidate.name,
    candidate.job.title,
    candidate.job.company,
    candidate.notes ?? undefined
  );

  return NextResponse.json({ email });
}

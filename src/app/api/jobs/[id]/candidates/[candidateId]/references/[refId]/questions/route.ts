import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateReferenceQuestions } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { safeParseJson } from "@/lib/utils";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string; refId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId, refId } = await params;
  const { job, candidate, error } = await requireCandidateAccess(id, candidateId, auth);
  if (error || !job || !candidate) return error;

  const ref = await prisma.referenceCheck.findUnique({ where: { id: refId, candidateId } });
  if (!ref) return NextResponse.json({ error: "Reference not found" }, { status: 404 });

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);

  const questions = await generateReferenceQuestions(
    candidate.name,
    candidate.profileText ?? candidate.headline ?? "",
    parsedRole?.title ?? job.title,
    parsedRole?.skills_required ?? [],
    ref.relationship ?? "colleague"
  );

  const updated = await prisma.referenceCheck.update({
    where: { id: refId },
    data: { questions: JSON.stringify(questions) },
  });

  return NextResponse.json(updated);
}

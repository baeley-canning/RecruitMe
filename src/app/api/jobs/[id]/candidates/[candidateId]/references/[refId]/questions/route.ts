import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateReferenceQuestions } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { safeParseJson } from "@/lib/utils";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";
import { checkSpendCap } from "@/lib/usage";

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

  const spend = await checkSpendCap(auth.orgId);
  if (!spend.allowed) {
    return NextResponse.json(
      { error: `Daily AI spend cap reached ($${spend.spentUsd.toFixed(2)} / $${spend.capUsd.toFixed(2)}). Try again tomorrow or raise AI_DAILY_SPEND_CAP_USD.` },
      { status: 429 },
    );
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);

  const questions = await generateReferenceQuestions(
    candidate.name,
    candidate.profileText ?? candidate.headline ?? "",
    parsedRole?.title ?? job.title,
    parsedRole?.skills_required ?? [],
    ref.relationship ?? "colleague",
    { orgId: auth.orgId, userId: auth.userId }
  );

  const updated = await prisma.referenceCheck.update({
    where: { id: refId },
    data: { questions: JSON.stringify(questions) },
  });

  return NextResponse.json(updated);
}

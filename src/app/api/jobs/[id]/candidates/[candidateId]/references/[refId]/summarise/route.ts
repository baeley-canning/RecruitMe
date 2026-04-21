import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { summariseReferenceCheck } from "@/lib/ai";
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
  if (!ref.responses) return NextResponse.json({ error: "No responses to summarise" }, { status: 422 });

  type QA = { question: string; answer: string };
  const responses = safeParseJson<QA[]>(ref.responses, []);
  if (!responses.length) return NextResponse.json({ error: "No responses to summarise" }, { status: 422 });

  const summary = await summariseReferenceCheck(
    candidate.name,
    job.title,
    { name: ref.refereeName, title: ref.refereeTitle ?? undefined, company: ref.refereeCompany ?? undefined },
    responses
  );

  const updated = await prisma.referenceCheck.update({
    where: { id: refId },
    data: { summary, status: "complete" },
  });

  return NextResponse.json(updated);
}

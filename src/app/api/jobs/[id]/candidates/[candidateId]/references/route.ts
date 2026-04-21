import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;
  const { error } = await requireCandidateAccess(id, candidateId, auth);
  if (error) return error;

  const refs = await prisma.referenceCheck.findMany({
    where: { candidateId },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(refs);
}

const CreateRefSchema = z.object({
  refereeName:    z.string().min(1).max(200).trim(),
  refereeTitle:   z.string().max(200).trim().optional(),
  refereeCompany: z.string().max(200).trim().optional(),
  refereeEmail:   z.string().email().max(300).optional().or(z.literal("")),
  refereePhone:   z.string().max(50).trim().optional(),
  relationship:   z.string().max(100).trim().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;
  const { error } = await requireCandidateAccess(id, candidateId, auth);
  if (error) return error;

  const result = CreateRefSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 422 });

  const ref = await prisma.referenceCheck.create({
    data: { candidateId, ...result.data },
  });
  return NextResponse.json(ref, { status: 201 });
}

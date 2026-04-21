import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";

const PatchRefSchema = z.object({
  refereeName:    z.string().min(1).max(200).trim().optional(),
  refereeTitle:   z.string().max(200).trim().optional(),
  refereeCompany: z.string().max(200).trim().optional(),
  refereeEmail:   z.string().email().max(300).optional().or(z.literal("")),
  refereePhone:   z.string().max(50).trim().optional(),
  relationship:   z.string().max(100).trim().optional(),
  status:         z.enum(["pending", "contacted", "received", "complete"]).optional(),
  responses:      z.string().optional(), // JSON string of [{question, answer}]
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string; refId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId, refId } = await params;
  const { error } = await requireCandidateAccess(id, candidateId, auth);
  if (error) return error;

  const result = PatchRefSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 422 });

  const ref = await prisma.referenceCheck.update({
    where: { id: refId, candidateId },
    data: result.data,
  });
  return NextResponse.json(ref);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string; refId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId, refId } = await params;
  const { error } = await requireCandidateAccess(id, candidateId, auth);
  if (error) return error;

  await prisma.referenceCheck.delete({ where: { id: refId, candidateId } });
  return NextResponse.json({ ok: true });
}

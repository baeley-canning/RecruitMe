import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { safeParseJson } from "@/lib/utils";

const VALID_STATUSES = [
  "new", "reviewing", "shortlisted", "contacted",
  "interviewing", "offer_sent", "hired", "declined", "rejected",
] as const;

const PatchCandidateSchema = z.object({
  status:      z.enum(VALID_STATUSES).optional(),
  notes:       z.string().max(10_000).optional(),
  name:        z.string().min(1).max(200).trim().optional(),
  headline:    z.string().max(500).trim().optional(),
  location:    z.string().max(200).trim().optional(),
  linkedinUrl: z.string().url().max(500).optional().or(z.literal("")),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const { candidateId } = await params;
  const result = PatchCandidateSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }
  const body = result.data;

  // Build base update
  const data: Record<string, unknown> = {
    ...(body.notes       !== undefined && { notes: body.notes }),
    ...(body.name        !== undefined && { name: body.name }),
    ...(body.headline    !== undefined && { headline: body.headline }),
    ...(body.location    !== undefined && { location: body.location }),
    ...(body.linkedinUrl !== undefined && { linkedinUrl: body.linkedinUrl || null }),
  };

  // If status is changing, append to history and track contactedAt
  if (body.status !== undefined) {
    const existing = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { status: true, statusHistory: true, contactedAt: true },
    });

    data.status = body.status;

    if (existing && body.status !== existing.status) {
      const history = safeParseJson<Array<{ status: string; changedAt: string }>>(
        existing.statusHistory,
        []
      );
      history.push({ status: body.status, changedAt: new Date().toISOString() });
      data.statusHistory = JSON.stringify(history);

      if (body.status === "contacted" && !existing.contactedAt) {
        data.contactedAt = new Date();
      }
    }
  }

  const candidate = await prisma.candidate.update({
    where: { id: candidateId },
    data,
  });

  return NextResponse.json(candidate);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const { candidateId } = await params;
  await prisma.candidate.delete({ where: { id: candidateId } });
  return NextResponse.json({ ok: true });
}

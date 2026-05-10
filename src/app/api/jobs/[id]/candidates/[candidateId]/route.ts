import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { safeParseJson } from "@/lib/utils";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";

const VALID_STATUSES = [
  "new", "reviewing", "shortlisted", "contacted",
  "interviewing", "offer_sent", "hired", "declined", "rejected",
] as const;

const PatchCandidateSchema = z.object({
  status:        z.enum(VALID_STATUSES).optional(),
  notes:         z.string().max(10_000).optional(),
  name:          z.string().min(1).max(200).trim().optional(),
  headline:      z.string().max(500).trim().optional(),
  location:      z.string().max(200).trim().optional(),
  linkedinUrl:   z.string().url().max(500).optional().or(z.literal("")),
  jobAdderUrl:   z.string().url().max(500).optional().or(z.literal("")),
  screeningData:   z.string().optional(), // JSON string
  interviewNotes:  z.string().optional(), // JSON string
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;
  const { error } = await requireCandidateAccess(id, candidateId, auth);
  if (error) return error;
  const result = PatchCandidateSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }
  const body = result.data;
  const linkedinUrl = body.linkedinUrl !== undefined
    ? body.linkedinUrl ? normaliseLinkedInUrl(body.linkedinUrl) : null
    : undefined;

  // Build base update
  const data: Record<string, unknown> = {
    ...(body.notes         !== undefined && { notes: body.notes }),
    ...(body.name          !== undefined && { name: body.name }),
    ...(body.headline      !== undefined && { headline: body.headline }),
    ...(body.location      !== undefined && { location: body.location }),
    ...(linkedinUrl        !== undefined && { linkedinUrl }),
    ...(body.jobAdderUrl   !== undefined && { jobAdderUrl: body.jobAdderUrl || null }),
    ...(body.screeningData  !== undefined && { screeningData: body.screeningData }),
    ...(body.interviewNotes !== undefined && { interviewNotes: body.interviewNotes }),
  };

  // If status is changing, append to history and track contactedAt. The read
  // (existing.statusHistory) and the write (data.statusHistory =
  // JSON.stringify(history)) must run in a single transaction or two
  // concurrent PATCHes can both read the same prior history and clobber each
  // other's appended event. Serializable isolation prevents the lost-update.
  if (body.status !== undefined) {
    const candidate = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.candidate.findUnique({
          where: { id: candidateId },
          select: { status: true, statusHistory: true, contactedAt: true },
        });

        const txData: Record<string, unknown> = { ...data, status: body.status };

        if (existing && body.status !== existing.status) {
          const history = safeParseJson<Array<{ status: string; changedAt: string }>>(
            existing.statusHistory,
            []
          );
          history.push({ status: body.status!, changedAt: new Date().toISOString() });
          txData.statusHistory = JSON.stringify(history);

          if (body.status === "contacted" && !existing.contactedAt) {
            txData.contactedAt = new Date();
          }
        }

        return tx.candidate.update({ where: { id: candidateId }, data: txData });
      },
      { isolationLevel: "Serializable" }
    );
    return NextResponse.json(candidate);
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
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;
  const { error } = await requireCandidateAccess(id, candidateId, auth);
  if (error) return error;
  await prisma.candidate.delete({ where: { id: candidateId } });
  return NextResponse.json({ ok: true });
}

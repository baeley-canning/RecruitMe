import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

const VALID_STATUSES = [
  "new", "reviewing", "shortlisted", "contacted",
  "interviewing", "offer_sent", "hired", "declined", "rejected",
] as const;

const BulkStatusSchema = z.object({
  candidateIds: z.array(z.string()).min(1).max(200),
  status: z.enum(VALID_STATUSES),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id: jobId } = await params;
  const result = BulkStatusSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const { candidateIds, status } = result.data;
  const changedAt = new Date().toISOString();

  // Fetch existing statusHistory for each candidate to append
  const candidates = await prisma.candidate.findMany({
    where: {
      id: { in: candidateIds },
      jobId,
      ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }),
    },
    select: { id: true, statusHistory: true },
  });

  if (candidates.length === 0) {
    return NextResponse.json({ updated: 0 });
  }

  const updates = await Promise.allSettled(
    candidates.map(c => {
      const history = c.statusHistory
        ? (() => { try { return JSON.parse(c.statusHistory) as unknown[]; } catch { return []; } })()
        : [];
      history.push({ status, changedAt });
      return prisma.candidate.update({
        where: { id: c.id },
        data: { status, statusHistory: JSON.stringify(history) },
      });
    })
  );

  const updated = updates.filter(r => r.status === "fulfilled").length;
  const failed = updates.length - updated;

  return NextResponse.json({ updated, failed });
}

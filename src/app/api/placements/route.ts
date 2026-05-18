import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

const CreatePlacementSchema = z.object({
  candidateId:    z.string(),
  jobId:          z.string().optional().nullable(),
  clientId:       z.string().optional().nullable(),
  submissionId:   z.string().optional().nullable(),
  placedAt:       z.string().datetime().optional(),
  startDate:      z.string().datetime().optional().nullable(),
  salaryPlaced:   z.number().int().min(0).max(5_000_000).optional().nullable(),
  feeType:        z.enum(["fixed", "percentage"]).optional(),
  feePct:         z.number().min(0).max(100).optional().nullable(),
  feeAmount:      z.number().int().min(0).optional().nullable(),
  invoiceRef:     z.string().max(200).optional().nullable(),
  invoicedAt:     z.string().datetime().optional().nullable(),
  paidAt:         z.string().datetime().optional().nullable(),
  guaranteeMonths: z.number().int().min(0).max(24).optional().nullable(),
  notes:          z.string().max(2000).optional().nullable(),
});

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const where = auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" };
  const placements = await prisma.placement.findMany({
    where,
    orderBy: { placedAt: "desc" },
    include: {
      client: { select: { id: true, name: true } },
    },
  });
  return NextResponse.json(placements);
}

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return NextResponse.json({ error: "No org assigned" }, { status: 400 });

  const result = CreatePlacementSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const d = result.data;
  const guaranteeExpiry = d.guaranteeMonths && d.placedAt
    ? new Date(new Date(d.placedAt).getTime() + d.guaranteeMonths * 30 * 24 * 60 * 60 * 1000)
    : d.guaranteeMonths
    ? new Date(Date.now() + d.guaranteeMonths * 30 * 24 * 60 * 60 * 1000)
    : null;

  const placement = await prisma.placement.create({
    data: {
      orgId: auth.orgId,
      candidateId: d.candidateId,
      jobId: d.jobId ?? null,
      clientId: d.clientId ?? null,
      submissionId: d.submissionId ?? null,
      placedAt: d.placedAt ? new Date(d.placedAt) : new Date(),
      startDate: d.startDate ? new Date(d.startDate) : null,
      salaryPlaced: d.salaryPlaced ?? null,
      feeType: d.feeType ?? "percentage",
      feePct: d.feePct ?? null,
      feeAmount: d.feeAmount ?? null,
      invoiceRef: d.invoiceRef ?? null,
      invoicedAt: d.invoicedAt ? new Date(d.invoicedAt) : null,
      paidAt: d.paidAt ? new Date(d.paidAt) : null,
      guaranteeMonths: d.guaranteeMonths ?? null,
      guaranteeExpiry,
      notes: d.notes ?? null,
    },
  });

  // Auto-create guarantee_check reminder 7 days before expiry
  if (guaranteeExpiry) {
    const reminderDue = new Date(guaranteeExpiry.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (reminderDue > new Date()) {
      await prisma.reminder.create({
        data: {
          orgId: auth.orgId,
          userId: auth.userId,
          candidateId: d.candidateId,
          jobId: d.jobId ?? null,
          clientId: d.clientId ?? null,
          placementId: placement.id,
          type: "guarantee_check",
          dueAt: reminderDue,
          note: `Guarantee expires ${guaranteeExpiry.toLocaleDateString("en-NZ")}`,
        },
      });
    }
  }

  return NextResponse.json(placement, { status: 201 });
}

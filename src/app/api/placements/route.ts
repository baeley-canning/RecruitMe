import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized, requireJobAccess } from "@/lib/session";
import { isCrmEnabled } from "@/lib/feature-flags";

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
  if (!isCrmEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
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
  if (!isCrmEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return NextResponse.json({ error: "No org assigned" }, { status: 400 });

  const result = CreatePlacementSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const d = result.data;

  // Verify every supplied FK belongs to the caller's org (audit L1) — stops
  // creating a placement that points at another tenant's candidate/client/sub.
  const orgScope = auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" };
  const candidate = await prisma.candidate.findFirst({
    where: { id: d.candidateId, ...orgScope },
    select: { id: true },
  });
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  if (d.clientId) {
    const client = await prisma.client.findFirst({ where: { id: d.clientId, ...orgScope }, select: { id: true } });
    if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }
  if (d.jobId) {
    const { error } = await requireJobAccess(d.jobId, auth);
    if (error) return error;
  }
  if (d.submissionId) {
    const sub = await prisma.submission.findFirst({ where: { id: d.submissionId, ...orgScope }, select: { id: true } });
    if (!sub) return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }

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
